from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

from cdx_switchboard.handoff import (
    AccountSelection,
    HandoffError,
    TRANSIENT_UNIT,
    helper_command,
    operation_lock,
    perform_handoff,
    prepare_log,
    runtime_directory,
    schedule_handoff,
)


class FakeSystemctl:
    def __init__(self):
        self.events = []
        self.state = "active"

    def __call__(self, command, **kwargs):
        if "stop" in command:
            self.events.append("stop")
            self.state = "inactive"
            return subprocess.CompletedProcess(command, 0, "", "")
        if "start" in command:
            self.events.append("start")
            self.state = "active"
            return subprocess.CompletedProcess(command, 0, "", "")
        if "ActiveState" in " ".join(command):
            return subprocess.CompletedProcess(command, 0, self.state + "\n", "")
        return subprocess.CompletedProcess(command, 0, "", "")


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = runtime_directory({}, temp_root=self.root)

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def which(name):
        return f"/usr/bin/{name}"

    def test_detached_systemd_helper_construction(self):
        command = helper_command(
            "/usr/bin/systemd-run",
            Path("/opt/cdx-switchboard/cdx"),
            self.runtime,
            {},
        )
        self.assertEqual(command[0:2], ["/usr/bin/systemd-run", "--user"])
        self.assertIn(f"--unit={TRANSIENT_UNIT}", command)
        self.assertIn("--collect", command)
        self.assertIn("--property=Type=exec", command)
        self.assertNotIn("--no-block", command)
        self.assertEqual(command[-2:], ["/opt/cdx-switchboard/cdx", "_switch-helper"])

    def test_systemd_user_services_unavailable(self):
        runner = Mock(return_value=subprocess.CompletedProcess([], 1, "", ""))
        with self.assertRaisesRegex(HandoffError, "unavailable"):
            schedule_handoff(Path("/opt/cdx"), runner=runner, which=self.which, environ={})

    def test_missing_systemd_command_fails(self):
        with self.assertRaisesRegex(HandoffError, "requires"):
            schedule_handoff(Path("/opt/cdx"), which=lambda name: None, environ={})

    def test_stop_switch_verify_start_order(self):
        systemd = FakeSystemctl()
        events = systemd.events

        def switch():
            events.append("switch")
            return AccountSelection("two", "two", True)

        def verify():
            events.append("verify")
            return "two"

        perform_handoff(
            switch,
            verify,
            directory=self.runtime,
            runner=systemd,
            which=self.which,
            sleeper=lambda _: None,
        )
        self.assertEqual(events, ["stop", "switch", "verify", "start"])

    def test_t3_restarts_after_switching_fails(self):
        systemd = FakeSystemctl()

        def fail():
            raise RuntimeError("ranking failed")

        with self.assertRaises(HandoffError):
            perform_handoff(
                fail,
                lambda: "unused",
                directory=self.runtime,
                runner=systemd,
                which=self.which,
                sleeper=lambda _: None,
            )
        self.assertEqual(systemd.events, ["stop", "start"])
        log = (self.runtime / "last-switch.log").read_text()
        self.assertIn("account switch failure", log)
        self.assertIn("T3 restarted", log)
        self.assertIn("final failure", log)

    def test_t3_restarts_after_verification_fails(self):
        systemd = FakeSystemctl()
        with self.assertRaises(HandoffError):
            perform_handoff(
                lambda: AccountSelection("two", "two", True),
                lambda: "one",
                directory=self.runtime,
                runner=systemd,
                which=self.which,
                sleeper=lambda _: None,
            )
        self.assertEqual(systemd.events, ["stop", "start"])
        self.assertIn("verification result: failure", (self.runtime / "last-switch.log").read_text())

    def test_t3_restart_is_attempted_when_stop_fails(self):
        systemd = FakeSystemctl()

        def fail_stop(command, **kwargs):
            if "stop" in command:
                systemd.events.append("stop")
                return subprocess.CompletedProcess(command, 1, "", "")
            return systemd(command, **kwargs)

        with self.assertRaises(HandoffError):
            perform_handoff(
                lambda: self.fail("switch must not run"),
                lambda: self.fail("verification must not run"),
                directory=self.runtime,
                runner=fail_stop,
                which=self.which,
                sleeper=lambda _: None,
            )
        self.assertEqual(systemd.events, ["stop", "start"])
        log = (self.runtime / "last-switch.log").read_text()
        self.assertIn("account switch failure: not attempted", log)
        self.assertIn("verification result: not performed", log)

    def test_concurrent_operation_locking(self):
        with operation_lock(self.runtime):
            with self.assertRaisesRegex(HandoffError, "already running"):
                perform_handoff(
                    lambda: AccountSelection("one", "one", False),
                    lambda: "one",
                    directory=self.runtime,
                    runner=FakeSystemctl(),
                    which=self.which,
                    sleeper=lambda _: None,
                )

    def test_private_temporary_log_is_replaced(self):
        log_path = prepare_log(self.runtime)
        log_path.write_text("old sensitive-looking contents")
        prepare_log(self.runtime)
        self.assertEqual(log_path.read_text(), "")
        self.assertEqual(self.runtime.stat().st_mode & 0o777, 0o700)
        self.assertEqual(log_path.stat().st_mode & 0o777, 0o600)

    def test_successful_already_best_behavior(self):
        systemd = FakeSystemctl()
        perform_handoff(
            lambda: AccountSelection("one", "one", False),
            lambda: "one",
            directory=self.runtime,
            runner=systemd,
            which=self.which,
            sleeper=lambda _: None,
        )
        log = (self.runtime / "last-switch.log").read_text()
        self.assertIn("no account change necessary", log)
        self.assertIn("final success", log)


if __name__ == "__main__":
    unittest.main()

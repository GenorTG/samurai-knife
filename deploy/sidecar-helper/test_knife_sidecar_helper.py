"""Unit tests for knife-sidecar-helper: request parsing (no app input reaches argv) and compose validation.

Run: python3 -I deploy/sidecar-helper/test_knife_sidecar_helper.py   (also run by tests/sidecar_helper.test.mjs)
"""

import copy
import importlib.machinery
import importlib.util
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("knife_sidecar_helper", os.path.join(HERE, "knife-sidecar-helper"))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)

CONF = dict(helper.CONF_DEFAULTS, ALLOW_BIND_HOSTS="127.0.0.1,100.64.0.7", BUNDLE_ROOT="/etc/samurai-knife/sidecars")
DIR = "/tmp/scratch"


def good_learn_db():
    return {
        "name": "samurai-knife-learn-db",
        "networks": {"default": {"name": "samurai-knife-learn-db_default"}},
        "services": {
            "postgres": {
                "image": "postgis/postgis:16-3.4",
                "restart": "no",
                "env_file": [{"path": f"{DIR}/secrets.env", "required": True}],
                "environment": {"POSTGRES_USER": "postgres", "POSTGRES_DB": "learn"},
                "extra_hosts": ["host.docker.internal:host-gateway"],
                "labels": {"dev.samurai-knife.managed": "true", "dev.samurai-knife.service": "learn-db"},
                "mem_limit": "1g",
                "cpus": "1",
                "networks": {"default": None},
                "ports": [{"host_ip": "127.0.0.1", "mode": "ingress", "protocol": "tcp", "published": "3211", "target": 5432}],
                "volumes": [{"source": "pgdata", "target": "/var/lib/postgresql/data", "type": "volume", "volume": {}}],
                "cap_drop": ["ALL"],
                "cap_add": ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"],
                "security_opt": ["no-new-privileges:true"],
                "pids_limit": 256,
            }
        },
        "volumes": {"pgdata": {"labels": {"dev.samurai-knife.service": "learn-db"}, "name": "samurai-knife-learn-db_pgdata"}},
    }


def good_office():
    cfg = good_learn_db()
    svc = cfg["services"].pop("postgres")
    svc["image"] = "ghcr.io/euro-office/documentserver:v9.3.5"
    svc["labels"]["dev.samurai-knife.service"] = "office"
    svc["cap_add"] = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"]
    svc["pids_limit"] = 1024
    svc["mem_limit"] = "3g"
    svc["ports"][0]["host_ip"] = "100.64.0.7"
    svc["volumes"] = [
        {"source": "data", "target": "/var/lib/euro-office/documentserver", "type": "volume", "volume": {}},
        {"bind": {"create_host_path": True}, "read_only": True, "source": f"{DIR}/assets",
         "target": "/var/www/euro-office/documentserver/sdkjs-plugins", "type": "bind"},
    ]
    cfg["name"] = "samurai-knife-office"
    cfg["networks"]["default"]["name"] = "samurai-knife-office_default"
    cfg["services"]["documentserver"] = svc
    cfg["volumes"] = {"data": {"name": "samurai-knife-office_data"}}
    return cfg


class ParseRequest(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(helper.parse_request("version"), ("version", None, frozenset()))
        self.assertEqual(helper.parse_request("up office"), ("up", "office", frozenset()))
        self.assertEqual(helper.parse_request("down learn-db volumes rmi"), ("down", "learn-db", frozenset({"volumes", "rmi"})))

    def test_refused(self):
        attacks = [
            "", " ", "up", "up  office", "up office ", "UP office", "up office;id", "up office\x00", "up ../office",
            "up office/../../x", "exec office", "run office", "up nginx", "up samurai-knife-office", "version office",
            "down office --volumes", "down office volumes volumes", "up office volumes", "stop office rmi",
            "up office$(id)", "up 'office'", "up office\tx", "up " + "a" * 40, "x" * 300, "pull office -f",
            "logs office --tail", "prepare learn-db extra", "hash", "ps ofice",
        ]
        for line in attacks:
            with self.subTest(line=line):
                with self.assertRaises(helper.HelperError) as ctx:
                    helper.parse_request(line)
                self.assertEqual(ctx.exception.code, 64)

    def test_argv_is_built_from_constants_only(self):
        for verb in ("ps", "logs", "pull", "up", "stop", "down"):
            argv = helper.compose_argv(CONF, verb, "office", frozenset({"volumes", "rmi"} if verb == "down" else ()))
            self.assertEqual(argv[0], "/usr/bin/docker")
            self.assertIn("/etc/samurai-knife/sidecars/office/compose.yaml", argv)
            self.assertIn("samurai-knife-office", argv)
        self.assertEqual(helper.compose_argv(CONF, "prepare", "office", frozenset())[-4:],
                         ["exec", "-T", "documentserver", "documentserver-generate-allfonts.sh"])
        self.assertEqual(helper.compose_argv(CONF, "down", "office", frozenset({"volumes", "rmi"}))[-5:],
                         ["down", "--remove-orphans", "--volumes", "--rmi", "all"])
        self.assertEqual(helper.compose_argv(CONF, "down", "office", frozenset())[-2:], ["down", "--remove-orphans"])
        with self.assertRaises(helper.HelperError):
            helper.compose_argv(CONF, "prepare", "learn-db", frozenset())
        pull = helper.compose_argv(CONF, "pull", "learn-db", frozenset())
        self.assertEqual(pull[1:4], ["compose", "--progress", "json"])


class Validate(unittest.TestCase):
    def assertRefused(self, sidecar_id, cfg, fragment):
        problems = helper.validate_config(sidecar_id, cfg, CONF, DIR)
        self.assertTrue(any(fragment in problem for problem in problems), f"{fragment!r} not in {problems}")

    def test_good_configs_pass(self):
        self.assertEqual(helper.validate_config("learn-db", good_learn_db(), CONF, DIR), [])
        self.assertEqual(helper.validate_config("office", good_office(), CONF, DIR), [])

    def mutate(self, fn, sidecar_id="learn-db"):
        cfg = good_learn_db() if sidecar_id == "learn-db" else good_office()
        svc = next(iter(cfg["services"].values()))
        fn(cfg, svc)
        return cfg

    def test_container_escapes_are_refused(self):
        cases = [
            (lambda c, s: s.update(privileged=True), "service keys not allowed"),
            (lambda c, s: s.update(network_mode="host"), "service keys not allowed"),
            (lambda c, s: s.update(pid="host"), "service keys not allowed"),
            (lambda c, s: s.update(devices=["/dev/sda:/dev/sda"]), "service keys not allowed"),
            (lambda c, s: s.update(sysctls={"net.ipv4.ip_forward": "1"}), "service keys not allowed"),
            (lambda c, s: s.update(cap_add=["SYS_ADMIN"]), "cap_add beyond"),
            (lambda c, s: s.update(cap_add=["CAP_NET_ADMIN"]), "cap_add beyond"),
            (lambda c, s: s.update(security_opt=["seccomp=unconfined"]), "security_opt not allowed"),
            (lambda c, s: s.update(security_opt=["apparmor=unconfined"]), "security_opt not allowed"),
            (lambda c, s: s.update(runtime="nvidia"), "runtime may only be runc"),
            (lambda c, s: s["volumes"].append({"type": "bind", "source": "/", "target": "/host", "read_only": False}), "bind mount"),
            (lambda c, s: s["volumes"].append({"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}), "bind mount"),
            (lambda c, s: s["volumes"].append({"type": "npipe", "source": "x", "target": "/x"}), "mount type"),
            (lambda c, s: s["volumes"].append({"type": "volume", "source": "other", "target": "/x"}), "not a declared named volume"),
            (lambda c, s: c["volumes"].update(pgdata={"driver_opts": {"type": "none", "o": "bind", "device": "/"}}), "only plain named volumes"),
            (lambda c, s: c["volumes"].update(pgdata={"external": True, "name": "kfinance_data"}), "only plain named volumes"),
            (lambda c, s: s["ports"][0].update(host_ip=""), "every address"),
            (lambda c, s: s["ports"][0].update(host_ip="0.0.0.0"), "allowed"),
            (lambda c, s: s["ports"][0].update(host_ip="192.168.1.10"), "allowed"),
            (lambda c, s: s["ports"][0].update(published="22"), "1024-65535"),
            (lambda c, s: s["ports"][0].update(published="3000-3999"), "1024-65535"),
            (lambda c, s: s["ports"][0].update(protocol="udp"), "tcp ingress"),
            (lambda c, s: s.update(env_file=[{"path": "/etc/shadow", "required": True}]), "env_file"),
            (lambda c, s: s.update(image="evil/postgres:16"), "image must start with"),
            (lambda c, s: s.update(restart="always"), "restart must be"),
            (lambda c, s: s.update(extra_hosts=["metadata:169.254.169.254"]), "extra_hosts"),
            (lambda c, s: s["labels"].pop("dev.samurai-knife.service"), "labels"),
            (lambda c, s: s.update(networks={"kfinance_kfinance-internal": None}), "service network"),
            (lambda c, s: c["networks"].update(other={"external": True}), "only the project's default network"),
            (lambda c, s: c.update(name="kfinance"), "project name"),
            (lambda c, s: c.update(secrets={"x": {"file": "/etc/shadow"}}), "top-level keys"),
            (lambda c, s: s.update(logging={"driver": "syslog"}), "logging driver"),
            (lambda c, s: c["services"].update(second=copy.deepcopy(s)), "exactly one service"),
        ]
        for fn, fragment in cases:
            with self.subTest(fragment=fragment):
                self.assertRefused("learn-db", self.mutate(fn), fragment)

    def test_missing_hardening_is_refused(self):
        """Host audit M2: the helper REQUIRES the hardening; a bundle without it never reaches docker."""
        cases = [
            (lambda c, s: s.pop("cap_drop"), "cap_drop must be exactly [ALL]"),
            (lambda c, s: s.update(cap_drop=[]), "cap_drop must be exactly [ALL]"),
            (lambda c, s: s.update(cap_drop=["NET_RAW"]), "cap_drop must be exactly [ALL]"),
            (lambda c, s: s.pop("security_opt"), "no-new-privileges"),
            (lambda c, s: s.update(security_opt=[]), "no-new-privileges"),
            (lambda c, s: s.pop("pids_limit"), "pids_limit must be set"),
            (lambda c, s: s.update(pids_limit=-1), "pids_limit must be set"),
            (lambda c, s: s.update(pids_limit=0), "pids_limit must be set"),
            (lambda c, s: s.update(pids_limit=100000), "pids_limit must be set"),
            (lambda c, s: s.update(pids_limit=True), "pids_limit must be set"),
            (lambda c, s: s.pop("mem_limit"), "mem_limit must be set"),
            (lambda c, s: s.update(mem_limit="64g"), "mem_limit must be set"),
            (lambda c, s: s.update(mem_limit="lots"), "mem_limit must be set"),
            (lambda c, s: s.pop("cap_add"), "exactly the definition's set"),
            (lambda c, s: s.update(cap_add=["CHOWN"]), "exactly the definition's set"),
            (lambda c, s: s.update(cap_add=s["cap_add"] + ["NET_RAW"]), "exactly the definition's set"),
        ]
        for sidecar_id in ("learn-db", "office"):
            for fn, fragment in cases:
                with self.subTest(sidecar=sidecar_id, fragment=fragment):
                    self.assertRefused(sidecar_id, self.mutate(fn, sidecar_id), fragment)

    def test_sizes(self):
        self.assertEqual(helper.parse_size("3g"), 3 * 1024 ** 3)
        self.assertEqual(helper.parse_size("512m"), 512 * 1024 ** 2)
        self.assertEqual(helper.parse_size(1073741824), 1073741824)
        self.assertIsNone(helper.parse_size("1 gigabyte"))
        self.assertIsNone(helper.parse_size(True))

    def test_office_assets_bind_must_be_read_only_and_fixed(self):
        self.assertRefused("office", self.mutate(lambda c, s: s["volumes"][1].update(read_only=False), "office"), "bind mount")
        self.assertRefused("office", self.mutate(lambda c, s: s["volumes"][1].update(target="/etc"), "office"), "bind mount")
        self.assertRefused("office", self.mutate(lambda c, s: s["volumes"][1].update(source="/etc/samurai-knife"), "office"), "bind mount")
        # learn-db has no assets: even the bundle's own assets dir may not be mounted.
        self.assertRefused("learn-db", self.mutate(lambda c, s: s["volumes"].append(
            {"type": "bind", "source": f"{DIR}/assets", "target": "/x", "read_only": True})), "bind mount")



class BundleDiff(unittest.TestCase):
    """`check`/`sync` explain a hash change over exactly the hashed inputs, and never print a secret value."""

    def make(self, root, name, compose, secrets, folders):
        directory = os.path.join(root, name)
        os.makedirs(os.path.join(directory, "assets"))
        with open(os.path.join(directory, "compose.yaml"), "w") as handle:
            handle.write(compose)
        with open(os.path.join(directory, "secrets.env"), "w") as handle:
            handle.write(secrets)
        for folder in folders:
            os.makedirs(os.path.join(directory, "assets", folder))
        return directory

    def test_same_bundle_has_no_lines(self):
        with tempfile.TemporaryDirectory() as root:
            a = self.make(root, "a", "name: x\n", "K=v1\n", ["conf-1"])
            b = self.make(root, "b", "name: x\n", "K=v1\n", ["conf-1"])
            self.assertEqual(helper.bundle_diff(a, b), [])
            self.assertEqual(helper.bundle_hash_of(a), helper.bundle_hash_of(b))

    def test_each_input_is_named(self):
        with tempfile.TemporaryDirectory() as root:
            installed = self.make(root, "installed", "name: x\nimage: a:1\n", "JWT_SECRET=topsecret111\n", ["conf-old", "keep"])
            staged = self.make(root, "staged", "name: x\nimage: a:2\n",
                               "JWT_SECRET=topsecret222\nSECURE_LINK_SECRET=hidden333\n", ["conf-new", "keep"])
            out = "\n".join(helper.bundle_diff(installed, staged))
            self.assertIn("compose.yaml differs:", out)
            self.assertIn("-image: a:1", out)
            self.assertIn("+image: a:2", out)
            self.assertIn("secrets.env changed (values not shown): keys added: SECURE_LINK_SECRET", out)
            self.assertIn("asset folders added: conf-new", out)
            self.assertIn("asset folders removed: conf-old", out)
            self.assertNotIn("keep", out)
            for value in ("topsecret111", "topsecret222", "hidden333"):
                self.assertNotIn(value, out)

    def test_changed_secret_value_only(self):
        with tempfile.TemporaryDirectory() as root:
            installed = self.make(root, "i", "name: x\n", "K=old\n", [])
            staged = self.make(root, "s", "name: x\n", "K=new\n", [])
            self.assertEqual(helper.bundle_diff(installed, staged), ["secrets.env changed (values not shown): a value changed"])

    def test_only_folder_names_differ(self):
        # The 2026-10-27 craft case: same compose and secret, an extra generated config folder staged.
        with tempfile.TemporaryDirectory() as root:
            installed = self.make(root, "i", "name: x\n", "K=v\n", ["conf-81536158cc00"])
            staged = self.make(root, "s", "name: x\n", "K=v\n", ["conf-81536158cc00", "conf-7486cb2cf425"])
            self.assertNotEqual(helper.bundle_hash_of(installed), helper.bundle_hash_of(staged))
            self.assertEqual(helper.bundle_diff(installed, staged), ["asset folders added: conf-7486cb2cf425"])

    def test_nothing_installed(self):
        with tempfile.TemporaryDirectory() as root:
            staged = self.make(root, "s", "name: x\n", "K=v\n", [])
            self.assertEqual(helper.bundle_diff(os.path.join(root, "missing"), staged), ["nothing installed yet: the whole staged bundle is new"])

    def test_long_compose_diff_is_capped(self):
        with tempfile.TemporaryDirectory() as root:
            installed = self.make(root, "i", "".join(f"a{i}: 1\n" for i in range(400)), "K=v\n", [])
            staged = self.make(root, "s", "".join(f"a{i}: 2\n" for i in range(400)), "K=v\n", [])
            out = helper.bundle_diff(installed, staged)
            self.assertLessEqual(len(out), helper.MAX_DIFF_LINES + 2)
            self.assertTrue(out[-1].startswith("  ... ") and out[-1].endswith("more diff lines"))

if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=1).result
    sys.exit(0 if result.wasSuccessful() else 1)

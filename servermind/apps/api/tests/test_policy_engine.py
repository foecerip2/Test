import datetime as dt

import pytest

from app.core.config import get_settings
from app.db.models import Server, ServerMetricSample
from app.modules.policy.catalog import CATALOG, READ_TOOLS, risk_rank
from app.modules.policy.engine import PolicyViolation, validate_proposal

IMG = "registry.servermind.example/demo/web:1.0.0"


def server(status="online"):
    return Server(name="web-1", host="h", port=22, username="u", host_key_openssh="k", fingerprint="f", status=status)


def sample(disk_used=12.0, services=(("nginx", "failed"), ("docker", "active"), ("postgresql", "active"))):
    return ServerMetricSample(sampled_at=dt.datetime.now(dt.UTC), disk_used_gb=disk_used, disk_total_gb=40.0,
                              services=[{"name": n, "state": s} for n, s in services])


def check(steps, *, srv=None, smp="default", role="operator"):
    return validate_proposal(steps, server=srv or server(), latest=sample() if smp == "default" else smp, role=role, settings=get_settings())


def reasons(steps, **kw):
    with pytest.raises(PolicyViolation) as e:
        check(steps, **kw)
    return " | ".join(e.value.reasons)


def test_catalog_has_no_shell_and_no_high_risk_tools():
    for name, spec in CATALOG.items():
        assert risk_rank(spec.risk) <= risk_rank("R3"), name
        assert "shell" not in name and "exec" not in name and "bash" not in name
    assert set(READ_TOOLS) == {"server.facts", "server.metrics", "service.status"}
    assert CATALOG["domain.configure_https"].enabled is False  # manual-only до security review


def test_valid_restart_plan_is_normalized():
    steps = check([{"tool": "service.restart", "params": {"unit": "nginx"}},
                   {"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/healthz"}}])
    assert [s["tool"] for s in steps] == ["service.restart", "http.healthcheck"]
    assert steps[0]["risk"] == "R2" and steps[0]["id"] == "s1" and steps[1]["optional"] is True
    assert steps[1]["params"] == {"url": "http://127.0.0.1:8080/healthz", "expect_status": 200, "timeout_s": 10}  # значения по умолчанию добавлены


@pytest.mark.parametrize("tool", ["shell.exec", "bash", "rm -rf /", "docker.run", "system.reboot", "file.write", "", "SERVICE.RESTART",
                                   "domain.configure_https", None, 5, ["service.restart"]])
def test_unknown_or_disabled_tools_rejected(tool):
    assert "не входит в список одобренных" in reasons([{"tool": tool, "params": {}}])


@pytest.mark.parametrize("bad", [
    {"unit": "nginx; rm -rf /"}, {"unit": "nginx\nsshd"}, {"unit": "../x"}, {"unit": ""}, {"unit": "nginx", "extra": 1}, {}, {"unit": 5},
])
def test_service_restart_param_injection_rejected(bad):
    assert "некорректные параметры" in reasons([{"tool": "service.restart", "params": bad}])


def test_only_managed_and_present_services_can_be_restarted():
    assert "не входит в список управляемых" in reasons([{"tool": "service.restart", "params": {"unit": "sshd"}}])
    assert "не входит в список управляемых" in reasons([{"tool": "service.restart", "params": {"unit": "postgresql"}}])
    assert "не найдена на сервере" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}],
                                              smp=sample(services=(("docker", "active"),)))


def test_mutations_require_online_server_with_data():
    assert "недоступен" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}], srv=server("offline"))
    assert "недоступен" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}], smp=None)


def test_viewer_cannot_create_plans():
    assert "роль" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}], role="viewer")


def test_disk_90_blocks_heavy_operations():
    d = {"template": "web-app", "image": IMG, "port": 8080}
    assert "заблокированы" in reasons([{"tool": "docker.install", "params": {}}, {"tool": "app.deploy_compose", "params": d}], smp=sample(disk_used=36.5))
    assert "нет данных о диске" in reasons([{"tool": "docker.install", "params": {}}], smp=ServerMetricSample(sampled_at=dt.datetime.now(dt.UTC), services=[]))
    check([{"tool": "service.restart", "params": {"unit": "nginx"}}], smp=sample(disk_used=39.0))  # лёгкая операция не блокируется


@pytest.mark.parametrize("bad", [
    {"template": "custom", "image": IMG, "port": 8080},                       # только проверенный шаблон
    {"template": "web-app", "image": "evil/x:1", "port": 8080},              # не из разрешённого реестра
    {"template": "web-app", "image": "registry.servermind.example/x:latest", "port": 8080},
    {"template": "web-app", "image": IMG, "port": 80},                       # привилегированный порт
    {"template": "web-app", "image": IMG, "port": 8080, "privileged": True},
    {"template": "web-app", "image": IMG, "port": 8080, "read_only_rootfs": False},
    {"template": "web-app", "image": IMG, "port": 8080, "env_keys": ["lower"]},
    {"template": "web-app", "image": IMG, "port": 8080, "volumes": ["/:/host"]},
    {"template": "web-app", "image": IMG, "port": 8080, "network_mode": "host"},
    {"template": "web-app", "image": IMG, "port": 8080, "docker_sock": True},
    {"template": "web-app", "image": IMG, "port": 8080, "compose": "services: {}"},
])
def test_deploy_cannot_escape_the_template(bad):
    assert reasons([{"tool": "docker.install", "params": {}}, {"tool": "app.deploy_compose", "params": bad}])


def test_docker_group_membership_forbidden():
    assert "некорректные параметры" in reasons([{"tool": "docker.install", "params": {"add_user_to_docker_group": True}}])


def test_deploy_requires_docker_or_prior_install_and_single_deploy():
    d = {"tool": "app.deploy_compose", "params": {"template": "web-app", "image": IMG, "port": 8080}}
    no_docker = sample(services=(("nginx", "active"),))
    assert "нужен запущенный Docker" in reasons([d], smp=no_docker)
    assert [s["tool"] for s in check([{"tool": "docker.install", "params": {}}, d], smp=no_docker)] == ["docker.install", "app.deploy_compose"]
    assert "один деплой" in reasons([d, dict(d, params={"template": "web-app", "image": IMG, "port": 8081})])


@pytest.mark.parametrize("url", ["http://169.254.169.254/latest", "http://example.com/", "https://127.0.0.1/", "http://localhost:8080/", "file:///etc/passwd",
                                 "http://127.0.0.1:8080/../../x?y=z", "http://127.0.0.1@evil.com:80/"])
def test_healthcheck_cannot_reach_the_network(url):
    assert "некорректные параметры" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}, {"tool": "http.healthcheck", "params": {"url": url}}])


def test_plan_shape_and_size_limits():
    assert "от 1 до 8" in reasons([])
    assert "от 1 до 8" in reasons("rm -rf /")
    assert "от 1 до 8" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}] * 9)
    assert "ожидается объект" in reasons([{"tool": "service.restart"}])
    assert "ожидается объект" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}, "cmd": "id"}])
    assert "дублирует" in reasons([{"tool": "service.restart", "params": {"unit": "nginx"}}] * 2)
    assert "хотя бы одно изменение" in reasons([{"tool": "http.healthcheck", "params": {"url": "http://127.0.0.1:8080/"}}])


def test_all_reasons_are_reported_and_secrets_in_tool_names_redacted():
    r = reasons([{"tool": "password=hunter2", "params": {}}, {"tool": "service.restart", "params": {"unit": "bad unit"}}])
    assert "hunter2" not in r and r.count("Шаг") >= 2

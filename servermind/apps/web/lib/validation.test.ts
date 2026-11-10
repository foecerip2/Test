import { describe, expect, it } from "vitest";
import { checkDomain, checkEmail, checkHost, checkPort, checkUsername, maskKey } from "./validation";

describe("checkHost (SSRF-политика, UX-уровень)", () => {
  it.each(["203.0.113.10", "8.8.8.8", "example.com", "app.servermind.example", "sub.domain.co.uk"])("допускает %s", (h) => {
    expect(checkHost(h).ok).toBe(true);
  });
  it.each([
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "localhost", "db.local", "svc.internal", "::1", "fe80::1", "999.1.1.1", "", "   ", "-bad.example.com", "no_tld", "a..b.com",
  ])("отклоняет %s", (h) => {
    expect(checkHost(h).ok).toBe(false);
  });
  it("172.32.x.x — публичный адрес", () => expect(checkHost("172.32.0.1").ok).toBe(true));
});

describe("порт, пользователь, email, домен", () => {
  it("порт", () => {
    expect(checkPort("22")).toEqual({ ok: true, port: 22 });
    for (const p of ["0", "65536", "abc", "", "22.5", "-1"]) expect(checkPort(p).ok).toBe(false);
  });
  it("root запрещён, прочие имена — по шаблону", () => {
    expect(checkUsername("root").ok).toBe(false);
    expect(checkUsername("servermind").ok).toBe(true);
    expect(checkUsername("Bad Name").ok).toBe(false);
    expect(checkUsername("").ok).toBe(false);
  });
  it("email и домен", () => {
    expect(checkEmail("a@b.co")).toBe(true);
    expect(checkEmail("a@b")).toBe(false);
    expect(checkDomain("app.servermind.example")).toBe(true);
    expect(checkDomain("http://x.com")).toBe(false);
  });
});

describe("maskKey", () => {
  it("не раскрывает середину ключа", () => {
    const k = "sk-SECRETSECRETSECRET1234";
    const m = maskKey(k);
    expect(m).toBe("sk-••••1234");
    expect(m).not.toContain("SECRET");
  });
  it("короткие ключи маскируются полностью", () => expect(maskKey("abc")).toBe("••••"));
});

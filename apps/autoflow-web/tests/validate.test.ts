import { describe, expect, it } from "vitest";
import { isEmail, normalizePhone, validatePilot, type PilotFields } from "@/lib/validate";

const ok: PilotFields = {
  business_name: "Автосервис «Пример»",
  city: "Казань",
  contact_name: "Иван",
  phone: "8 (900) 000-00-00",
  email: "",
  consent: true,
  website: "",
};

describe("normalizePhone", () => {
  it("приводит российские форматы к +7", () => {
    expect(normalizePhone("8 (900) 000-00-00")).toBe("+79000000000");
    expect(normalizePhone("+7 900 000 00 00")).toBe("+79000000000");
    expect(normalizePhone("9000000000")).toBe("+79000000000");
  });
  it("принимает международные номера и отклоняет мусор", () => {
    expect(normalizePhone("+375 29 123-45-67")).toBe("+375291234567");
    expect(normalizePhone("12345")).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });
});

describe("isEmail", () => {
  it("проверяет адреса", () => {
    expect(isEmail("a.b+c@example.com")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@example.com")).toBe(false);
    expect(isEmail("@example.com")).toBe(false);
  });
});

describe("validatePilot", () => {
  it("принимает заявку только с телефоном", () => {
    const r = validatePilot(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ business_name: "Автосервис «Пример»", city: "Казань", contact_name: "Иван", phone: "+79000000000", email: null, consent: true, website: "" });
  });
  it("принимает заявку только с e-mail", () => {
    const r = validatePilot({ ...ok, phone: "", email: "ivan@example.com" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.phone).toBeNull();
  });
  it("требует хотя бы один способ связи", () => {
    const r = validatePilot({ ...ok, phone: "", email: " " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.contact).toBeTruthy();
  });
  it("требует согласие", () => {
    const r = validatePilot({ ...ok, consent: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.consent).toBeTruthy();
  });
  it("проверяет обязательные текстовые поля и длину", () => {
    const r = validatePilot({ ...ok, business_name: " ", city: "К", contact_name: "и".repeat(81) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["business_name", "city", "contact_name"]);
  });
  it("сообщает о неверном телефоне и e-mail по отдельности", () => {
    const r = validatePilot({ ...ok, phone: "123", email: "bad" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.phone).toBeTruthy();
      expect(r.errors.email).toBeTruthy();
      expect(r.errors.contact).toBeUndefined();
    }
  });
});

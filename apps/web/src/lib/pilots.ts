import type { PilotStatus, Tone } from "./api/types";

export const PILOT_LABEL: Record<PilotStatus, string> = {
  new: "Новая", contacted: "Связались", accepted: "Принята в пилот", declined: "Отклонена", spam: "Спам",
};
export const PILOT_TONE: Record<PilotStatus, Tone> = {
  new: "amber", contacted: "neutral", accepted: "green", declined: "neutral", spam: "red",
};

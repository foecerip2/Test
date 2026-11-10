/** Rule-based классификация ответов (режим без AI, ТЗ §10 A). Всегда помечается как low-confidence. `unsubscribe` приоритетнее всего. */
import type { ConversationStage } from "./api/types";

const RULES: { label: ConversationStage; re: RegExp; confidence: number }[] = [
  { label: "unsubscribe", re: /(не\s+(пиш|присыла|звон|беспоко)|больше\s+не|отпиш|отписк|удалите|уберите|исключите|из\s+рассылк|прекрат|stop|unsubscribe)/i, confidence: 0.9 },
  { label: "wrong_contact", re: /(не\s+по\s+адресу|не\s+тот\s+(контакт|адрес)|ошиблись|не\s+(наш|к\s+нам))/i, confidence: 0.75 },
  { label: "not_interested", re: /(не\s+актуальн|не\s+интересн|не\s+нужн|откаж|не\s+подход)/i, confidence: 0.8 },
  { label: "later", re: /(позже|потом|в\s+следующ|через\s+(месяц|неделю|время)|не\s+сейчас)/i, confidence: 0.7 },
  { label: "interested", re: /(интересн|сколько\s+стоит|покажите|расскажите|давайте|готовы\s+обсудить|присылайте)/i, confidence: 0.7 },
  { label: "question", re: /(\?|как\s+|есть\s+ли|можно\s+ли|интеграц)/i, confidence: 0.6 },
];

export function classifyReply(text: string): { label: ConversationStage; confidence: number } {
  for (const r of RULES) if (r.re.test(text)) return { label: r.label, confidence: r.confidence };
  return { label: "ambiguous", confidence: 0.3 };
}

export const STAGE_LABEL: Record<ConversationStage, string> = {
  new: "Новый", replied: "Ответил", interested: "Заинтересован", question: "Вопрос", later: "Позже",
  not_interested: "Не интересно", unsubscribe: "Отписка", wrong_contact: "Не тот контакт", ambiguous: "Неясно", closed: "Закрыт",
};

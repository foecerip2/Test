"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { Notice, StatusTag } from "../ui";
import { ApiError, getApi, type ImportPreview, type ImportResult } from "@/lib/api";
import m from "./import.module.css";

const MAX_BYTES = 2 * 1024 * 1024;
const TEMPLATE = "﻿название;город;категория;сайт;инн\r\nСТО «Пример»;Казань;Автосервис;sto-primer.ru;\r\n";

type Step = "file" | "preview" | "done";

function downloadTemplate() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" }));
  a.download = "leadhunter-import-template.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Файл → текст: UTF-8, а если не получилось — Windows-1251 (так Excel для Windows сохраняет CSV). */
export function decodeCsv(buf: ArrayBuffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1251").decode(buf); }
}

export function ImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("file");
  const [fileName, setFileName] = useState("");
  // Текст файла живёт в состоянии между шагами: сервер получает его и на предпросмотре, и на импорте.
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const prevStep = useRef(step);
  const live = process.env.NEXT_PUBLIC_DATA_MODE === "live";
  // При смене шага прежний сфокусированный элемент исчезает — переносим фокус на заголовок диалога.
  useEffect(() => {
    if (prevStep.current === step) return;
    prevStep.current = step;
    box.current?.closest<HTMLElement>('[role="dialog"]')?.querySelector<HTMLElement>("h2")?.focus();
  }, [step]);

  async function load(file: File | undefined) {
    setError(null); setPreview(null);
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) { setError("Файлы Excel (XLSX) пока не поддерживаются. Сохраните таблицу как CSV (UTF-8) и загрузите снова."); return; }
    if (!/\.(csv|txt)$/i.test(file.name)) { setError("Нужен файл в формате CSV."); return; }
    if (file.size > MAX_BYTES) { setError("Файл больше 2 МБ. Разделите его на части."); return; }
    setBusy(true);
    try {
      const text = decodeCsv(await file.arrayBuffer());
      setFileName(file.name);
      const p = await getApi().imports.preview(text);
      setPreview(p);
      if (p.missingColumns.length) setError(`В файле нет обязательных колонок: ${p.missingColumns.join(", ")}.`);
      else { setCsvText(text); setOnlyProblems(false); setStep("preview"); }
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Не удалось прочитать файл.");
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true); setError(null);
    try { setResult(await getApi().imports.commit(csvText)); setStep("done"); }
    catch (x) { setError(x instanceof ApiError ? x.message : "Не удалось выполнить импорт."); }
    finally { setBusy(false); }
  }

  const rows = preview?.rows ?? [];
  const sum = preview?.summary ?? { total: 0, importable: 0, withIssues: 0, exact: 0, inFile: 0, candidates: 0 };
  const shown = (onlyProblems ? rows.filter((r) => r.issues.length || r.duplicate) : rows).slice(0, 20);
  const hasNotes = sum.withIssues + sum.exact + sum.inFile + sum.candidates > 0;

  return (
    <Modal title="Импорт компаний из CSV" onClose={onClose}>
      <div className={m.wide} style={{ width: "100%" }} ref={box}>
        {step === "file" && (
          <>
            <p>Колонки: название и город — обязательны; категория, сайт, ИНН — по желанию. Разделитель — запятая, точка с запятой или табуляция.</p>
            <label className={`${m.drop} ${over ? m.over : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void load(e.dataTransfer.files[0]); }}>
              <Icon name="upload" />
              <strong>Выберите файл или перетащите сюда</strong>
              <span className="small muted">CSV (UTF-8 или Windows-1251), до 2 МБ и 5000 строк</span>
              <input type="file" accept=".csv,.txt,.xlsx,.xls,text/csv" className="sr-only" data-autofocus onChange={(e) => void load(e.target.files?.[0])} />
            </label>
            <div className="spacer-top row"><button type="button" className="btn btn-sm" onClick={downloadTemplate}><Icon name="download" /> Скачать шаблон CSV</button></div>
            {busy && <p className="small muted spacer-top" role="status">Читаем файл…</p>}
            {error && <div className="spacer-top"><Notice tone="danger" icon="alert"><span role="alert">{error}</span></Notice></div>}
            <div className="dialog-actions"><button className="btn" onClick={onClose}>Закрыть</button></div>
          </>
        )}
        {step === "preview" && preview && (
          <>
            <Notice tone="info" icon="info">Предпросмотр (dry-run): пока ничего не записано. Файл: {fileName}</Notice>
            <div className={`${m.sum} spacer-top`}>
              <div><strong>{sum.total}</strong>строк всего</div>
              <div><strong>{sum.importable}</strong>к импорту</div>
              <div><strong>{sum.exact + sum.inFile}</strong>точные дубли</div>
              <div><strong>{sum.candidates}</strong>возможные дубли</div>
              <div><strong>{sum.withIssues}</strong>с ошибками</div>
            </div>
            {hasNotes && (
              <label className="small row" style={{ gap: 8, marginBottom: 8 }}>
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Только строки с замечаниями
              </label>
            )}
            <div className={`table-wrap ${m.tbl}`} tabIndex={0} role="region" aria-label="Предпросмотр строк файла">
              <table className="data-table" style={{ minWidth: 560 }}>
                <caption className="sr-only">Первые 20 строк файла</caption>
                <thead><tr><th scope="col">Строка</th><th scope="col">Название</th><th scope="col">Город</th><th scope="col">Сайт</th><th scope="col">Отметка</th></tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td><td>{r.name || "—"}</td><td>{r.city || "—"}</td><td>{r.website ?? "—"}</td>
                      <td>
                        {r.issues.length ? <StatusTag tone="red">{r.issues.join("; ")}</StatusTag>
                          : r.duplicate?.kind === "candidate" ? <StatusTag tone="amber">Похоже на «{r.duplicate.of}»</StatusTag>
                          : r.duplicate?.kind === "in_file" ? <StatusTag tone="red">Дубль в файле: {r.duplicate.of}</StatusTag>
                          : r.duplicate ? <StatusTag tone="red">Дубль: {r.duplicate.of}</StatusTag>
                          : <StatusTag tone="green">Новая</StatusTag>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > shown.length && <p className="small muted">Показаны первые {shown.length} из {onlyProblems ? "строк с замечаниями" : `${rows.length} строк`}.</p>}
            <Notice tone="info" icon="shield">Дедупликация: сначала ИНН, затем сайт и город, затем похожее название в том же городе — это только кандидат на ручную проверку, он импортируется с пометкой. Филиалы одной сети не сливаются только по домену. Строки с ошибками и точные дубли будут пропущены.{live ? " Сервер заново проверит файл при импорте." : ""}</Notice>
            {error && <div className="spacer-top"><Notice tone="danger" icon="alert"><span role="alert">{error}</span></Notice></div>}
            <div className="dialog-actions">
              <button className="btn" onClick={() => { setStep("file"); setPreview(null); setCsvText(""); setError(null); }}>Назад</button>
              <button className="btn btn-primary" disabled={busy || sum.importable === 0} onClick={commit} title={sum.importable === 0 ? "Нет строк для импорта" : undefined}>Импортировать {sum.importable}</button>
            </div>
          </>
        )}
        {step === "done" && result && (
          <>
            <Notice tone="ok" icon="tick"><span role="status">Добавлено компаний: {result.added}{result.candidates > 0 ? ` (с пометкой «возможный дубль»: ${result.candidates})` : ""}. Пропущено: {result.skipped}.</span></Notice>
            <div className="dialog-actions">
              <button className="btn" onClick={onClose}>Закрыть</button>
              <Link className="btn btn-primary" href="/companies" onClick={onClose}>Открыть базу компаний</Link>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

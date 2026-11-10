"use client";
import Link from "next/link";
import { useState } from "react";
import { Icon } from "../Icon";
import { Modal } from "../Modal";
import { Notice, StatusTag } from "../ui";
import { ApiError, getApi, type ImportRow } from "@/lib/api";
import m from "./import.module.css";

const MAX_BYTES = 2 * 1024 * 1024;
const TEMPLATE = "﻿название;город;категория;сайт;инн\r\nСТО «Пример»;Казань;Автосервис;primer-sto.example;\r\n";

type Step = "file" | "preview" | "done";
interface Preview { rows: ImportRow[]; missingColumns: string[] }

function downloadTemplate() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" }));
  a.download = "leadhunter-import-template.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

const isExact = (r: ImportRow) => r.duplicate?.kind === "exact" || r.duplicate?.kind === "in_file";

export function ImportWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<Step>("file");
  const [fileName, setFileName] = useState("");
  
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null);

  async function load(file: File | undefined) {
    setError(null); setPreview(null);
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) { setError("XLSX будет доступен в Фазе 2. Сохраните таблицу как CSV (UTF-8) и загрузите снова."); return; }
    if (!/\.(csv|txt)$/i.test(file.name)) { setError("Нужен файл в формате CSV."); return; }
    if (file.size > MAX_BYTES) { setError("Файл больше 2 МБ. Разделите его на части."); return; }
    setBusy(true);
    try {
      const t = await file.text();
      setFileName(file.name);
      const p = await getApi().imports.preview(t);
      setPreview(p);
      if (p.missingColumns.length) setError(`В файле нет обязательных колонок: ${p.missingColumns.join(", ")}.`);
      else setStep("preview");
    } catch (x) {
      setError(x instanceof ApiError ? x.message : "Не удалось прочитать файл.");
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true); setError(null);
    try { setResult(await getApi().imports.commit(preview.rows)); setStep("done"); }
    catch (x) { setError(x instanceof ApiError ? x.message : "Не удалось выполнить импорт."); }
    finally { setBusy(false); }
  }

  const rows = preview?.rows ?? [];
  const bad = rows.filter((r) => r.issues.length).length;
  const exact = rows.filter((r) => !r.issues.length && isExact(r)).length;
  const cand = rows.filter((r) => !r.issues.length && r.duplicate?.kind === "candidate").length;
  const ok = rows.length - bad - exact;

  return (
    <Modal title="Импорт компаний из CSV" onClose={onClose}>
      <div className={m.wide} style={{ width: "100%" }}>
        {step === "file" && (
          <>
            <p>Колонки: название и город — обязательны; категория, сайт, ИНН — по желанию. Разделитель — запятая, точка с запятой или табуляция.</p>
            <label className={`${m.drop} ${over ? m.over : ""}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); void load(e.dataTransfer.files[0]); }}>
              <Icon name="upload" />
              <strong>Выберите файл или перетащите сюда</strong>
              <span className="small muted">CSV, до 2 МБ. XLSX — в Фазе 2</span>
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
              <div><strong>{rows.length}</strong>строк всего</div>
              <div><strong>{ok}</strong>к импорту</div>
              <div><strong>{exact}</strong>точные дубли</div>
              <div><strong>{cand}</strong>возможные дубли</div>
              <div><strong>{bad}</strong>с ошибками</div>
            </div>
            <div className={`table-wrap ${m.tbl}`}>
              <table className="data-table" style={{ minWidth: 560 }}>
                <caption className="sr-only">Первые 20 строк файла</caption>
                <thead><tr><th scope="col">Строка</th><th scope="col">Название</th><th scope="col">Город</th><th scope="col">Сайт</th><th scope="col">Отметка</th></tr></thead>
                <tbody>
                  {rows.slice(0, 20).map((r) => (
                    <tr key={r.line}>
                      <td>{r.line}</td><td>{r.name || "—"}</td><td>{r.city || "—"}</td><td>{r.website ?? "—"}</td>
                      <td>
                        {r.issues.length ? <StatusTag tone="red">{r.issues.join("; ")}</StatusTag>
                          : r.duplicate?.kind === "candidate" ? <StatusTag tone="amber">Похоже на «{r.duplicate.of}»</StatusTag>
                          : r.duplicate ? <StatusTag tone="red">Дубль: {r.duplicate.of}</StatusTag>
                          : <StatusTag tone="green">Новая</StatusTag>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > 20 && <p className="small muted">Показаны первые 20 из {rows.length} строк.</p>}
            <Notice tone="info" icon="shield">Дедупликация: сначала ИНН, затем сайт и город, затем похожее название в том же городе — это только кандидат на ручную проверку, он импортируется с пометкой. Филиалы одной сети не сливаются только по домену. Строки с ошибками и точные дубли будут пропущены.</Notice>
            {error && <div className="spacer-top"><Notice tone="danger" icon="alert"><span role="alert">{error}</span></Notice></div>}
            <div className="dialog-actions">
              <button className="btn" onClick={() => { setStep("file"); setPreview(null); }}>Назад</button>
              <button className="btn btn-primary" disabled={busy || ok === 0} onClick={commit} title={ok === 0 ? "Нет строк для импорта" : undefined}>Импортировать {ok}</button>
            </div>
          </>
        )}
        {step === "done" && result && (
          <>
            <Notice tone="ok" icon="tick"><span role="status">Добавлено компаний: {result.added}. Пропущено: {result.skipped}.</span></Notice>
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

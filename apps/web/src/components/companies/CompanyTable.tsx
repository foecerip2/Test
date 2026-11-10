"use client";
import Link from "next/link";
import { Icon } from "../Icon";
import { ScoreBadge, StatusTag } from "../ui";
import type { Company } from "@/lib/api";

export type SortKey = "score" | "name" | "updated";

interface Sort { key: SortKey; dir: "asc" | "desc" }

function Th({ label, k, sort, onSort }: { label: string; k: SortKey; sort?: Sort; onSort?: (k: SortKey) => void }) {
  if (!onSort) return <th scope="col">{label}</th>;
  const active = sort?.key === k;
  return (
    <th scope="col" aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="sort-btn" onClick={() => onSort(k)} type="button">
        {label}<span aria-hidden="true">{active ? (sort!.dir === "asc" ? "↑" : "↓") : ""}</span>
      </button>
    </th>
  );
}

export function CompanyTable({ items, caption, threshold = 75, sort, onSort }: {
  items: Company[]; caption: string; threshold?: number; sort?: Sort; onSort?: (k: SortKey) => void;
}) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="data-table cards">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <Th label="Компания" k="name" sort={sort} onSort={onSort} />
            <th scope="col">Регион</th>
            <Th label="Оценка" k="score" sort={sort} onSort={onSort} />
            <th scope="col">Статус</th>
            <th scope="col"><span className="sr-only">Действия</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr key={c.id}>
              <td>
                <Link href={`/companies/${c.id}`} className="cell-name" style={{ textDecoration: "none", color: "var(--ink)" }}>{c.name}</Link>
                <span className="cell-sub">{c.category}</span>
              </td>
              <td>{c.city}</td>
              <td><ScoreBadge score={c.score} threshold={threshold} /></td>
              <td><StatusTag status={c.display} /></td>
              <td><Link className="link-btn" href={`/companies/${c.id}`} aria-label={`Открыть карточку: ${c.name}`}>Открыть <Icon name="arrow" /></Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

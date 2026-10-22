/* 수익률·순위·평균 계산 */
(function (global) {
  const PERIOD_KEY = { "1": "r1", "3": "r3", "5": "r5", "7": "r7", "10": "r10" };
  const DO_PERIOD = { "1m": "r1m", "3m": "r3m", "6m": "r6m", "1y": "r1y", "3y": "r3y" };

  function num(v) {
    return v == null || v === "" || Number.isNaN(+v) ? null : +v;
  }

  function sortQuarters(keys) {
    return [...keys].sort((a, b) => {
      const [ya, qa] = a.split("Q").map(Number);
      const [yb, qb] = b.split("Q").map(Number);
      return ya === yb ? qa - qb : ya - yb;
    });
  }

  function prevQuarter(q) {
    const [y, qq] = q.split("Q").map(Number);
    return qq === 1 ? `${y - 1}Q4` : `${y}Q${qq - 1}`;
  }

  function nextQuarter(q) {
    const [y, qq] = q.split("Q").map(Number);
    if (!y || !qq) return null;
    return qq === 4 ? `${y + 1}Q1` : `${y}Q${qq + 1}`;
  }

  /** 사업자별 type map 구성 */
  function indexReturns(rows) {
    const byName = new Map();
    for (const row of rows || []) {
      if (!byName.has(row.name)) {
        byName.set(row.name, { name: row.name, sector: row.sector, types: {} });
      }
      byName.get(row.name).types[row.type] = row;
    }
    return byName;
  }

  /**
   * 상품유형 메트릭 추출.
   * typeFilter: 예금성|시장성|실적배당형|원리금보장(통합)|원리금보장
   */
  function metricFor(entry, plan, typeFilter, period) {
    if (!entry) return { aum: null, ret: null };
    const pk = PERIOD_KEY[String(period)] || "r1";
    const types = entry.types;

    if (typeFilter === "원리금보장(통합)") {
      const dep = types["예금성"];
      const mkt = types["시장성"];
      const legacy = types["원리금보장"];
      if (dep || mkt) {
        const d = dep ? dep[plan] : null;
        const m = mkt ? mkt[plan] : null;
        const da = d ? num(d.aum) : null;
        const ma = m ? num(m.aum) : null;
        const dr = d ? num(d[pk]) : null;
        const mr = m ? num(m[pk]) : null;
        const aum = (da || 0) + (ma || 0) || null;
        let ret = null;
        if (dr != null && mr != null && da != null && ma != null && aum) {
          ret = (da * dr + ma * mr) / aum;
        } else if (dr != null && (mr == null || ma == null || ma === 0)) {
          ret = dr;
          return { aum: da, ret };
        } else if (mr != null && (dr == null || da == null || da === 0)) {
          ret = mr;
          return { aum: ma, ret };
        }
        return { aum, ret };
      }
      if (legacy) {
        const b = legacy[plan];
        return { aum: num(b && b.aum), ret: num(b && b[pk]) };
      }
      return { aum: null, ret: null };
    }

    const t = types[typeFilter];
    if (!t) return { aum: null, ret: null };
    const b = t[plan];
    return { aum: num(b && b.aum), ret: num(b && b[pk]) };
  }

  function totalAum(entry, plan) {
    if (!entry) return null;
    let sum = 0;
    let any = false;
    for (const t of Object.keys(entry.types)) {
      if (t === "원리금보장" || t === "예금성" || t === "시장성" || t === "실적배당형") {
        const a = num(entry.types[t][plan] && entry.types[t][plan].aum);
        if (a != null) {
          sum += a;
          any = true;
        }
      }
    }
    // avoid double-count: if both 원리금보장 and 예금성 exist, prefer split
    if (entry.types["예금성"] || entry.types["시장성"]) {
      sum = 0;
      any = false;
      for (const t of ["예금성", "시장성", "실적배당형"]) {
        const block = entry.types[t] && entry.types[t][plan];
        const a = num(block && block.aum);
        if (a != null) {
          sum += a;
          any = true;
        }
      }
    }
    return any ? sum : null;
  }

  function equityShare(entry, plan) {
    const tot = totalAum(entry, plan);
    const eq = metricFor(entry, plan, "실적배당형", "1").aum;
    if (tot == null || !tot || eq == null) return null;
    return (eq / tot) * 100;
  }

  /** 업권/전체 실적배당 비중 (적립금 합산) */
  function equityShareAggregate(indexed, plan, sector) {
    let eqSum = 0;
    let totSum = 0;
    let any = false;
    for (const entry of indexed.values()) {
      if (sector && sector !== "전체" && entry.sector !== sector) continue;
      const tot = totalAum(entry, plan);
      const eq = metricFor(entry, plan, "실적배당형", "1").aum;
      if (tot == null || tot <= 0) continue;
      totSum += tot;
      if (eq != null) eqSum += eq;
      any = true;
    }
    return any && totSum ? (eqSum / totSum) * 100 : null;
  }

  function rankList(indexed, opts) {
    const {
      plan,
      type,
      period,
      sector,
      minAum = 0,
      avgMode = "weighted",
    } = opts;
    const list = [];
    for (const entry of indexed.values()) {
      if (sector && sector !== "전체" && entry.sector !== sector) continue;
      const m = metricFor(entry, plan, type, period);
      if (m.ret == null) continue;
      if (minAum > 0 && (m.aum == null || m.aum < minAum)) continue;
      list.push({
        name: entry.name,
        sector: entry.sector,
        aum: m.aum,
        ret: m.ret,
        equityShare: equityShare(entry, plan),
        totalAum: totalAum(entry, plan),
      });
    }
    list.sort((a, b) => b.ret - a.ret || (b.aum || 0) - (a.aum || 0));
    assignCompetitionRanks(list, (row) => row.ret);
    const avg = averageOf(list, avgMode);
    return { list, avg, n: list.length };
  }

  /** 동률이면 같은 순위, 다음은 건너뜀 (예: 1,1,3) */
  function assignCompetitionRanks(list, valueOf) {
    let rank = 0;
    let last = null;
    let hasLast = false;
    list.forEach((row, i) => {
      const v = valueOf(row);
      if (!hasLast || v !== last) {
        rank = i + 1;
        last = v;
        hasLast = true;
      }
      row.rank = rank;
    });
    return list;
  }

  function averageOf(list, mode) {
    if (!list.length) return null;
    if (mode === "simple") {
      return list.reduce((s, r) => s + r.ret, 0) / list.length;
    }
    let numr = 0;
    let den = 0;
    for (const r of list) {
      if (r.aum != null && r.aum > 0 && r.ret != null) {
        numr += r.aum * r.ret;
        den += r.aum;
      }
    }
    return den ? numr / den : null;
  }

  function findRank(ranked, name) {
    return ranked.list.find((r) => r.name === name) || null;
  }

  function deltaRank(curRank, prevRank) {
    if (curRank == null || prevRank == null) return null;
    return prevRank - curRank; // + = 상승
  }

  function formatDelta(d) {
    if (d == null) return { text: "—", cls: "delta-same" };
    if (d > 0) return { text: `▲${d}`, cls: "delta-up" };
    if (d < 0) return { text: `▼${Math.abs(d)}`, cls: "delta-down" };
    return { text: "─", cls: "delta-same" };
  }

  function aggregateDefaults(rows, risk, periodKey) {
    const sortPk = DO_PERIOD[periodKey] || "r1y";
    const periodFields = ["r1m", "r3m", "r6m", "r1y", "r3y"];
    const byName = new Map();
    for (const row of rows || []) {
      if (risk && row.risk !== risk) continue;
      if (!byName.has(row.name)) {
        const w = {};
        periodFields.forEach((p) => {
          w[p] = { num: 0, den: 0 };
        });
        byName.set(row.name, {
          name: row.name,
          sector: row.sector,
          aum: 0,
          w,
        });
      }
      const e = byName.get(row.name);
      const a = num(row.aum) || 0;
      e.aum += a;
      periodFields.forEach((p) => {
        const r = num(row[p]);
        if (r != null && a > 0) {
          e.w[p].num += a * r;
          e.w[p].den += a;
        }
      });
    }
    const list = [];
    for (const e of byName.values()) {
      const rets = {};
      periodFields.forEach((p) => {
        rets[p] = e.w[p].den > 0 ? e.w[p].num / e.w[p].den : null;
      });
      const ret = rets[sortPk];
      if (ret == null) continue;
      list.push({
        name: e.name,
        sector: e.sector,
        aum: e.aum,
        ret,
        rets,
      });
    }
    list.sort((a, b) => b.ret - a.ret || (b.aum || 0) - (a.aum || 0));
    assignCompetitionRanks(list, (row) => row.ret);
    return list;
  }

  function feeRate(row, plan) {
    if (!row || !row[plan]) return null;
    return num(row[plan].rate);
  }

  /** 운용·자산·합계 (구 데이터는 ops/asset 없을 수 있음) */
  function feeParts(row, plan) {
    if (!row || !row[plan]) return null;
    const p = row[plan];
    const ops = num(p.ops);
    const asset = num(p.asset);
    let rate = num(p.rate);
    if (rate == null && ops != null && asset != null) rate = ops + asset;
    if (rate == null && ops == null && asset == null) return null;
    return { ops, asset, rate };
  }

  function rankFees(rows, plan, sector) {
    const list = [];
    for (const row of rows || []) {
      if (sector && sector !== "전체" && row.sector !== sector) continue;
      const parts = feeParts(row, plan);
      if (!parts || parts.rate == null) continue;
      list.push({
        name: row.name,
        sector: row.sector,
        rate: parts.rate,
        ops: parts.ops,
        asset: parts.asset,
        metric: row[plan].metric,
      });
    }
    list.sort((a, b) => a.rate - b.rate); // 낮을수록 1위
    assignCompetitionRanks(list, (row) => row.rate);
    return list;
  }

  global.Calc = {
    PERIOD_KEY,
    DO_PERIOD,
    num,
    sortQuarters,
    prevQuarter,
    nextQuarter,
    indexReturns,
    metricFor,
    totalAum,
    equityShare,
    equityShareAggregate,
    rankList,
    assignCompetitionRanks,
    averageOf,
    findRank,
    deltaRank,
    formatDelta,
    aggregateDefaults,
    feeRate,
    feeParts,
    rankFees,
    sector_of: null,
  };
})(window);

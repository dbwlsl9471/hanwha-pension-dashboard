/* 포털 원본 엑셀(SheetJS) 파서 */
(function (global) {
  const SKIP = new Set(["합계", "자사계열사", "기타 사업자"]);
  const TYPE_MAP = {
    "예금성 원리금보장": "예금성",
    "시장성 원리금보장": "시장성",
    "원리금비보장": "실적배당형",
    "원리금 비보장": "실적배당형",
    "원리금 보장": "원리금보장",
    "원리금보장": "원리금보장",
  };

  function sectorOf(name) {
    const n = String(name).replace(/\s/g, "");
    if (n.includes("은행") || n.endsWith("뱅크") || n.includes("iM뱅크")) return "은행";
    if (n.includes("증권")) return "증권";
    if (n.includes("생명") || n.includes("라이프") || n.includes("연금보험")) return "생보";
    if (n.includes("손해") || n.includes("화재") || n.includes("해상")) return "손보";
    return "기타";
  }

  function toNum(v) {
    if (v == null || v === "" || v === "-") return null;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").replace(/%/g, "").trim();
    if (!s || s === "-") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * 분기/연도 표기 정규화
   * 예: 242Q → 2024Q2, 24Q2 → 2024Q2, 2024Q2, 24 → 2024, 2025
   */
  function normalizePeriodKey(raw, kindHint) {
    if (raw == null || raw === "") return null;
    const s = String(raw).trim().toUpperCase().replace(/\s+/g, "").replace(/년|분기/g, "");
    if (!s) return null;

    let m = s.match(/^(\d{4})Q([1-4])$/);
    if (m) return `${m[1]}Q${m[2]}`;

    m = s.match(/^(\d{2})Q([1-4])$/);
    if (m) return `20${m[1]}Q${m[2]}`;

    // 242Q / 252Q (연도2자리 + 분기 + Q)
    m = s.match(/^(\d{2})([1-4])Q$/);
    if (m) return `20${m[1]}Q${m[2]}`;

    // 2024.2 / 2024-2 / 2024/2
    m = s.match(/^(\d{4})[-./]([1-4])$/);
    if (m) return `${m[1]}Q${m[2]}`;

    // 24.2 / 24-2
    m = s.match(/^(\d{2})[-./]([1-4])$/);
    if (m) return `20${m[1]}Q${m[2]}`;

    // 242 (연도2자리+분기) — 수수료가 아닐 때
    m = s.match(/^(\d{2})([1-4])$/);
    if (m && kindHint !== "fees") return `20${m[1]}Q${m[2]}`;

    m = s.match(/^(\d{4})$/);
    if (m) return m[1];

    m = s.match(/^(\d{2})$/);
    if (m) return `20${m[1]}`;

    return null;
  }

  /** 파일명에서 분기/연도 추출 (예: 수익률_242Q.xlsx → 2024Q2) */
  function keyFromFileName(fileName, kindHint) {
    if (!fileName) return null;
    const base = String(fileName)
      .replace(/\.[^.]+$/i, "")
      .toUpperCase()
      .replace(/\s+/g, "");

    const tryNorm = (token) => normalizePeriodKey(token, kindHint);

    const patterns = [
      /\d{4}Q[1-4]/, // 2024Q2
      /\d{2}Q[1-4]/, // 24Q2
      /\d{2}[1-4]Q/, // 242Q
      /\d{4}[-_.][1-4](?!\d)/, // 2024_2
      /\d{2}[-_.][1-4](?!\d)/, // 24-2
    ];
    for (const re of patterns) {
      const m = base.match(re);
      if (!m) continue;
      const token = m[0].replace(/[-_.]/, "Q"); // 2024_2 → 2024Q2
      const k = tryNorm(token) || tryNorm(m[0]);
      if (k) return k;
    }

    // 수수료: 파일명 속 20xx 연도
    if (kindHint === "fees" || kindHint == null) {
      const y = base.match(/(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/);
      if (y) return y[1];
    }

    // 끝부분 242 형태
    if (kindHint !== "fees") {
      const bare = base.match(/(?:^|[^0-9])(\d{2}[1-4])(?:[^0-9]|$)/);
      if (bare) {
        const k = tryNorm(bare[1]);
        if (k) return k;
      }
    }

    return null;
  }

  function sheetToMatrix(wb) {
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: false });
  }

  function detectKind(matrix) {
    const head =
      (matrix[0] && matrix[0][0] ? String(matrix[0][0]) : "") +
      (matrix[6] && matrix[6][0] ? String(matrix[6][0]) : "");
    if (head.includes("디폴트") || head.includes("사전지정")) return "defaults";
    if (
      head.includes("비용") ||
      head.includes("수수료") ||
      (matrix[6] && String(matrix[6][0] || "").includes("사업자"))
    ) {
      if (matrix[7] && String(matrix[7][1] || "").includes("운용관리")) return "fees";
    }
    if (
      head.includes("적립금") ||
      head.includes("운용수익률") ||
      (matrix[6] && String(matrix[6][0]) === "사업자명")
    )
      return "returns";
    if (matrix[7] && String(matrix[7][1] || "").includes("운용관리")) return "fees";
    if (matrix[6] && String(matrix[6][0] || "").includes("상품명")) return "defaults";
    return "returns";
  }

  function blockEmpty(b) {
    return !b || (b.aum == null && b.r1 == null && b.r3 == null && b.r5 == null && b.r7 == null && b.r10 == null);
  }

  function parseReturns(matrix, quarterKey) {
    let key = quarterKey;
    if (!key) {
      const y = toNum(matrix[2] && matrix[2][1]);
      const q = toNum(matrix[2] && matrix[2][3]);
      if (y && q) key = `${y}Q${q}`;
    }
    const rows = [];
    const problems = [];
    let skipped = 0;
    let cur = null;
    let scanned = 0;
    for (let r = 9; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      if (row[0]) cur = String(row[0]).trim();
      const typRaw = row[1] != null ? String(row[1]).trim() : "";
      if (!typRaw && !row[0]) continue;
      scanned++;
      if (!typRaw) {
        problems.push({ row: excelRow, name: cur || "", reason: "유형(원리금구분) 없음" });
        continue;
      }
      if (SKIP.has(typRaw)) {
        skipped++;
        continue;
      }
      if (!cur) {
        problems.push({ row: excelRow, name: "", reason: "사업자명 없음", detail: typRaw });
        continue;
      }
      const typ = TYPE_MAP[typRaw];
      if (!typ) {
        problems.push({
          row: excelRow,
          name: cur,
          reason: "알 수 없는 유형",
          detail: typRaw,
        });
        continue;
      }
      const block = (c0) => ({
        aum: toNum(row[c0]),
        r1: toNum(row[c0 + 1]),
        r3: toNum(row[c0 + 2]),
        r5: toNum(row[c0 + 3]),
        r7: toNum(row[c0 + 4]),
        r10: toNum(row[c0 + 5]),
      });
      const DB = block(2);
      const DC = block(8);
      const IRP = block(14);
      if (blockEmpty(DB) && blockEmpty(DC) && blockEmpty(IRP)) {
        problems.push({
          row: excelRow,
          name: cur,
          reason: "적립금·수익률 수치 없음",
          detail: typ,
        });
        continue;
      }
      rows.push({ name: cur, sector: sectorOf(cur), type: typ, DB, DC, IRP });
    }
    const issues = [];
    if (!key) issues.push("분기(연도/분기)를 파일에서 읽지 못했습니다. 분기/연도를 직접 입력하세요.");
    if (!rows.length) issues.push("인식된 수익률 행이 없습니다.");
    return { key, rows, problems, skipped, scanned, issues };
  }

  function parseDefaults(matrix, quarterKey) {
    const rows = [];
    const problems = [];
    let skipped = 0;
    let scanned = 0;
    for (let r = 8; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      const product = row[0] != null ? String(row[0]).trim() : "";
      const name = row[1] != null ? String(row[1]).trim() : "";
      const risk = row[4] != null ? String(row[4]).trim() : "";
      if (!product && !name && !risk) continue;
      scanned++;
      if (!name) {
        problems.push({ row: excelRow, name: "", reason: "사업자명 없음", detail: product });
        continue;
      }
      if (!risk) {
        problems.push({ row: excelRow, name, reason: "위험등급 없음", detail: product });
        continue;
      }
      const aum = toNum(row[7]);
      const r1y = toNum(row[11]);
      if (aum == null && r1y == null && toNum(row[8]) == null) {
        // still accept — many rows have "-" aum but rates
      }
      rows.push({
        name,
        sector: sectorOf(name),
        product,
        risk,
        aum_dc: toNum(row[5]),
        aum_irp: toNum(row[6]),
        aum: toNum(row[7]),
        r1m: toNum(row[8]),
        r3m: toNum(row[9]),
        r6m: toNum(row[10]),
        r1y: toNum(row[11]),
        r3y: toNum(row[12]),
      });
    }
    const issues = [];
    if (!quarterKey) issues.push("디폴트옵션은 분기/연도(예: 2026Q2)를 입력해 주세요.");
    if (!rows.length) issues.push("인식된 디폴트옵션 행이 없습니다.");
    return { key: quarterKey, rows, problems, skipped, scanned, issues };
  }

  function parseFees(matrix, yearKey) {
    let key = yearKey;
    if (!key) {
      const y = toNum(matrix[2] && matrix[2][1]);
      if (y) key = String(Math.trunc(y));
    }
    const rows = [];
    const problems = [];
    let skipped = 0;
    let scanned = 0;
    for (let r = 9; r < matrix.length; r++) {
      const row = matrix[r] || [];
      const excelRow = r + 1;
      const name = row[0] != null ? String(row[0]).trim() : "";
      if (!name) {
        if (row.some((c) => c != null && String(c).trim() !== "")) {
          scanned++;
          problems.push({ row: excelRow, name: "", reason: "사업자명 없음" });
        }
        continue;
      }
      scanned++;
      // 제도블록 6열: 운용(대면/비대면) · 자산(대면/비대면) · 합계(대면/비대면)
      const plan = (c0) => {
        const opsFace = toNum(row[c0]);
        const opsOnline = toNum(row[c0 + 1]);
        const assetFace = toNum(row[c0 + 2]);
        const assetOnline = toNum(row[c0 + 3]);
        const face = toNum(row[c0 + 4]);
        const online = toNum(row[c0 + 5]);
        const ops = opsFace != null ? opsFace : opsOnline;
        const asset = assetFace != null ? assetFace : assetOnline;
        const rate =
          face != null
            ? face
            : online != null
            ? online
            : ops != null && asset != null
            ? ops + asset
            : null;
        return {
          face,
          online,
          ops,
          asset,
          opsFace,
          opsOnline,
          assetFace,
          assetOnline,
          rate,
          metric: "수수료 비용부담률",
        };
      };
      const DB = plan(1);
      const DC = plan(7);
      const IRP = plan(13);
      if (DB.rate == null && DC.rate == null && IRP.rate == null) {
        problems.push({ row: excelRow, name, reason: "수수료율 수치 없음" });
        continue;
      }
      rows.push({ name, sector: sectorOf(name), DB, DC, IRP });
    }
    const issues = [];
    if (!key) issues.push("연도를 파일에서 읽지 못했습니다. 연도를 직접 입력하세요.");
    if (!rows.length) issues.push("인식된 수수료 행이 없습니다.");
    return { key, rows, problems, skipped, scanned, issues };
  }

  async function parseFile(file, opts = {}) {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const matrix = sheetToMatrix(wb);
    const kind = opts.kind || detectKind(matrix);
    const fromName = keyFromFileName(file && file.name, kind);
    const keyIn = normalizePeriodKey(opts.key, kind) || fromName || null;
    let result;
    if (kind === "defaults") result = parseDefaults(matrix, keyIn);
    else if (kind === "fees") result = parseFees(matrix, keyIn);
    else result = parseReturns(matrix, keyIn);
    const key =
      normalizePeriodKey(result.key, kind) ||
      fromName ||
      result.key ||
      null;
    const issues = [...(result.issues || [])];
    // 정규화·파일명으로 키가 생겼으면 '키 없음' 류 이슈 제거
    if (key) {
      for (let i = issues.length - 1; i >= 0; i--) {
        if (/분기|연도/.test(issues[i]) && /입력|읽지/.test(issues[i])) issues.splice(i, 1);
      }
    }
    return {
      kind,
      key,
      rows: result.rows,
      problems: result.problems || [],
      skipped: result.skipped || 0,
      scanned: result.scanned || 0,
      issues,
      fileName: file.name,
      previewRows: result.rows.length,
      keySource: normalizePeriodKey(opts.key, kind)
        ? "input"
        : fromName && key === fromName
        ? "filename"
        : "file",
    };
  }

  global.Parser = {
    parseFile,
    detectKind,
    sectorOf,
    toNum,
    normalizePeriodKey,
    keyFromFileName,
  };
})(window);

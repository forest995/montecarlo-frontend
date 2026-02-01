import {
  simulate,
  commentaryRun,
  exportExcel,
  getConfidenceFactors,
  exportJson
} from "./api";

import { useEffect, useMemo, useRef, useState } from "react";


const DRIVER_OPTIONS = [
  "Market & economic conditions",
  "Labour market & productivity",
  "Site & environmental conditions",
  "Regulatory environments",
  "Procurement & contract complexities",
  "Technology & commissioning complexity",
];

const DRIVER_TOOLTIPS = {
  "Market & economic conditions":
    "Changes in market prices and economic conditions that affect multiple cost items at the same time (e.g. materials escalation, inflation, fuel or energy costs). Use this when costs tend to rise or fall together due to broader market forces.",
  "Labour market & productivity":
    "Availability, cost, and productivity of labour that can influence multiple work packages simultaneously (e.g. wage pressure, labour shortages, industrial action, productivity variation).",
  "Site & environmental conditions":
    "Physical site conditions or environmental factors that can impact several cost items together (e.g. ground conditions, access constraints, utilities, weather).",
  "Regulatory environments":
    "Regulatory, approval, or authority requirements that may constrain delivery and affect multiple cost items at once (e.g. permits, possessions, third-party approvals, compliance conditions).",
  "Procurement & contract complexities":
    "Commercial and procurement factors that can influence costs across multiple packages (e.g. tender market behaviour, contract packaging, risk allocation, claims environment).",
  "Technology & commissioning complexity":
    "Complexity or uncertainty associated with systems, technology, testing, or commissioning that may affect multiple cost items together (e.g. system integration or unproven technology).",
};

const SENSITIVITY_LEVELS = ["none", "low", "medium", "high"];


function formatCbsIdDisplay(id) {
  const raw = String(id || "");
  const m = raw.match(/^([a-zA-Z]+)\s*0*(\d+)$/);
  if (!m) return raw.toUpperCase();
  const prefix = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(3, "0");
  return `${prefix}${num}`;
}


function formatRiskIdDisplay(id) {
  // Display-only formatting: e.g. r1 -> R001, R0003 -> R003
  const raw = String(id || "");
  const m = raw.match(/^([a-zA-Z]+)\s*0*(\d+)$/);
  if (!m) return raw.toUpperCase();
  const prefix = m[1].toUpperCase();
  const num = String(parseInt(m[2], 10)).padStart(3, "0");
  return `${prefix}${num}`;
}


function sensitivityToIndex(s) {
  const i = SENSITIVITY_LEVELS.indexOf(String(s || "").toLowerCase());
  return i === -1 ? 2 : i; // default = medium
}

function indexToSensitivity(i) {
  const idx = Math.min(3, Math.max(0, Number(i) || 0));
  return SENSITIVITY_LEVELS[idx];
}


const EXCLUDED_FACTORS = new Set(["% Allocation"]);

// PM-friendly labels + tooltips for confidence factors (frontend-only; backend keys remain unchanged)
const CONFIDENCE_LABELS = {
  "Very Conservative": "No Upside Risk",
  "Conservative": "Low Upside Risk",
  "Realistic": "Balanced Cost Range",
  "Target": "Target Cost with Upside Risk",
  "Aggressive": "High Upside Risk",
  "Very Aggressive": "Extreme Upside Risk",
  "User defined": "User Defined"
};

const CONFIDENCE_TOOLTIPS = {
  "Very Conservative": "Costs cannot exceed the base estimate.",
  "Conservative": "Limited cost growth above the base estimate.",
  "Realistic": "Typical cost variation around the base estimate.",
  "Target": "Stretch target with potential cost growth.",
  "Aggressive": "Significant exposure to cost growth.",
  "Very Aggressive": "Very large potential cost overruns.",
  "User defined": "Cost range entered directly by the user."
};

function confidenceLabel(k) {
  return CONFIDENCE_LABELS[k] || k;
}

function confidenceTooltip(k) {
  return CONFIDENCE_TOOLTIPS[k] || "";
}


function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function safeFilename(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// cbs01, cbs02 ... / r01, r02 ...
function makeSequentialId(prefix, n) {
  const s = String(n).padStart(2, "0");
  return `${prefix}${s}`;
}

async function fetchJsonOrThrow(res) {
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const detail = Array.isArray(data.detail)
      ? data.detail
      : [{ msg: "Request failed", detail: data || text }];
    const err = new Error("API error");
    err.detail = detail;
    throw err;
  }
  return data;
}

/**
 * Minimal CSV parsing helpers
 * - Splits by newlines then commas
 * - Strips surrounding quotes
 * - Good enough for MVP (no embedded commas inside quotes)
 */
function normaliseLines(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function splitRow(row) {
  return row
    .split(",")
    .map((c) => c.trim())
    .map((c) => c.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

/**
 * CBS CSV: names only
 * Supports:
 *  - Header: name
 *  - Single column without header
 *  - One name per line
 */
/**
 * CBS CSV: supports names only OR name + baseCost
 * Supports:
 *  - Header: name, baseCost (preferred)
 *  - Header aliases: cost, base_cost, base (for baseCost)
 *  - Single column without header (names only)
 *  - One name per line
 *
 * Returns: [{ name: string, baseCost: number|null }]
 */
function parseCbsCsv(csvText) {
  const lines = normaliseLines(csvText);
  if (lines.length === 0) return [];

  const header = splitRow(lines[0]).map((h) => String(h || "").toLowerCase());

  const findIdx = (aliases) => {
    for (const a of aliases) {
      const i = header.indexOf(String(a).toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  const nameIdx = findIdx(["name", "cbs", "cbsname"]);
  const baseIdx = findIdx(["basecost", "base_cost", "cost", "base"]);

  // 3-point (user defined) support
  const lowIdx = findIdx(["low", "lowcost", "best", "bestcase", "min"]);
  const mlIdx = findIdx(["mostlikely", "most_likely", "mostlikelycost", "mode", "ml"]);
  const highIdx = findIdx(["high", "highcost", "worst", "worstcase", "max"]);

  const out = [];
  const seen = new Set();

  const toNumOrNull = (v) => {
    const s = String(v ?? "").trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const hasTrioCols = lowIdx !== -1 && mlIdx !== -1 && highIdx !== -1;

  // Case A: Has header row with a name column
  if (nameIdx !== -1) {
    for (let i = 1; i < lines.length; i++) {
      const cells = splitRow(lines[i]);
      const name = (cells[nameIdx] || "").trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const baseCost = baseIdx !== -1 ? toNumOrNull(cells[baseIdx]) : null;

      let low = null, mostLikely = null, high = null;
      if (hasTrioCols) {
        low = toNumOrNull(cells[lowIdx]);
        mostLikely = toNumOrNull(cells[mlIdx]);
        high = toNumOrNull(cells[highIdx]);
      }

      out.push({ name, baseCost, low, mostLikely, high });
    }
    return out;
  }

  // Case B: No header row => treat as names-only (first col)
  for (let i = 0; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const name = (cells[0] || "").trim();
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, baseCost: null, low: null, mostLikely: null, high: null });
  }

  return out;
}

/**
 * Risks CSV: full fields (+ optional riskType)
 * Expected headers (aliases supported):
 *  name/risk, riskType/type, probability/p, low/lowCost, mostLikely/mostLikelyCost/mode, high/highCost
 */
function parseRisksCsv(csvText) {
  const lines = normaliseLines(csvText);
  if (lines.length === 0) return { risks: [], warnings: ["No rows found."] };

  const headerCells = splitRow(lines[0]).map((h) => h.toLowerCase());

  const idx = (aliases) => {
    for (const a of aliases) {
      const i = headerCells.indexOf(a.toLowerCase());
      if (i !== -1) return i;
    }
    return -1;
  };

  const nameIdx = idx(["name", "risk"]);
  const typeIdx = idx(["risktype", "type"]);
  const pIdx = idx(["probability", "p"]);
  const lowIdx = idx(["lowcost", "low"]);
  const mlIdx = idx(["mostlikelycost", "mostlikely", "mode"]);
  const highIdx = idx(["highcost", "high"]);

  const missing = [];
  if (nameIdx === -1) missing.push("name (or risk)");
  if (pIdx === -1) missing.push("probability (or p)");
  if (lowIdx === -1) missing.push("lowCost (or low)");
  if (mlIdx === -1) missing.push("mostLikelyCost (or mostLikely/mode)");
  if (highIdx === -1) missing.push("highCost (or high)");

  if (missing.length) {
    return {
      risks: [],
      warnings: [`Missing required headers: ${missing.join(", ")}`],
    };
  }

  const warnings = [];
  const parsed = [];

  for (let rowNum = 1; rowNum < lines.length; rowNum++) {
    const cells = splitRow(lines[rowNum]);

    const name = (cells[nameIdx] || "").trim();
    if (!name) {
      warnings.push(`Row ${rowNum + 1}: missing risk name; skipped.`);
      continue;
    }

    const toNum = (v) => {
      const n = Number(String(v || "").trim());
      return Number.isFinite(n) ? n : NaN;
    };

    let riskType = "contingent";
    if (typeIdx !== -1) {
      const raw = String(cells[typeIdx] || "").trim().toLowerCase();
      if (raw === "inherent" || raw === "contingent") {
        riskType = raw;
      } else if (raw) {
        warnings.push(`Row ${rowNum + 1}: invalid riskType '${raw}', defaulted to 'contingent'.`);
      }
    }

    let probability = toNum(cells[pIdx]);
    let lowCost = toNum(cells[lowIdx]);
    let mostLikelyCost = toNum(cells[mlIdx]);
    let highCost = toNum(cells[highIdx]);

    if (!Number.isFinite(probability)) {
      warnings.push(`Row ${rowNum + 1}: probability not a number; set to 0.`);
      probability = 0;
    }
    if (probability < 0 || probability > 1) {
      warnings.push(`Row ${rowNum + 1}: probability out of range; clamped to 0–1.`);
      probability = Math.min(1, Math.max(0, probability));
    }

    const fixCost = (val, label) => {
      if (!Number.isFinite(val)) {
        warnings.push(`Row ${rowNum + 1}: ${label} not a number; set to 0.`);
        return 0;
      }
      if (val < 0) {
        warnings.push(`Row ${rowNum + 1}: ${label} < 0; set to 0.`);
        return 0;
      }
      return val;
    };

    lowCost = fixCost(lowCost, "lowCost");
    mostLikelyCost = fixCost(mostLikelyCost, "mostLikelyCost");
    highCost = fixCost(highCost, "highCost");

    if (riskType === "inherent") {
      // Costs are ignored by your backend logic; keep UI consistent:
      lowCost = 0;
      mostLikelyCost = 0;
      highCost = 0;
    } else {
      // Optional sanity: warn only
      if (!(lowCost <= mostLikelyCost && mostLikelyCost <= highCost)) {
        warnings.push(
          `Row ${rowNum + 1}: expected low <= mostLikely <= high (got ${lowCost}, ${mostLikelyCost}, ${highCost}). Simulation will still run.`
        );
      }
    }

    parsed.push({ name, riskType, probability, lowCost, mostLikelyCost, highCost });
  }

  return { risks: parsed, warnings };
}

function App() {
  const DOMINANT_MIN = 0.30;
  const MODERATE_MIN = 0.15;
  const MAX_PER_GROUP = 6;
  const [status, setStatus] = useState("Loading…");
  const [confidenceFactors, setConfidenceFactors] = useState([]);
  const [confidenceFactorMap, setConfidenceFactorMap] = useState({});
  const [errors, setErrors] = useState([]);

  // Project metadata (UI-only; used later for Excel export)
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectManager, setProjectManager] = useState("");
  const [projectDate, setProjectDate] = useState("");
  const [projectNotes, setProjectNotes] = useState("");

  // Counters so new rows get nice IDs
  const cbsCounterRef = useRef(4); // start with 4 CBS items
  const riskCounterRef = useRef(2); // start with 2 risks

  // Default CBS starter headers
  const [cbsItems, setCbsItems] = useState([
    {
      id: "cbs01",
      name: "INVESTIGATION",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs02",
      name: "FUNCTIONAL DESIGN",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs03",
      name: "DETAILED DESIGN",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
    {
      id: "cbs04",
      name: "CONSTRUCTION",
      baseCost: 0,
      confidenceFactor: "Realistic",
      bestCaseCost: null,
      mostLikelyCost: null,
      worstCaseCost: null,
      driverGroup: "",
      sensitivity: "medium",
    },
  ]);

  // Risk Register
  const [risks, setRisks] = useState([
    {
      id: "r01",
      name: "Unknown services relocation",
      riskType: "contingent",
      probability: 0.2,
      lowCost: 200000,
      mostLikelyCost: 600000,
      highCost: 1200000,
    },
    {
      id: "r02",
      name: "Contamination disposal",
      riskType: "contingent",
      probability: 0.1,
      lowCost: 150000,
      mostLikelyCost: 400000,
      highCost: 900000,
    },
  ]);

  // Settings
  const [iterations, setIterations] = useState(5000);
  const [seed, setSeed] = useState(123456);


  // Correlation modelling (None | Standard)
  const [correlationMode, setCorrelationMode] = useState("none");

  // UI tabs (PR2)
  const [activeTab, setActiveTab] = useState("project");

  // Results
  const [results, setResults] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [sensitivity, setSensitivity] = useState([]);

  // Commentary (AI)
  const [commentary, setCommentary] = useState(null);
  const [commentaryMode, setCommentaryMode] = useState(null);
  const [isCommentaryRunning, setIsCommentaryRunning] = useState(false);
  const [commentaryError, setCommentaryError] = useState(null);

  const resetResults = () => {
    setResults(null);
    setSensitivity([]);

    // reset commentary as well
    setCommentary(null);
    setCommentaryMode(null);
    setIsCommentaryRunning(false);
    setCommentaryError(null);
  };

  // File inputs
  const cbsFileInputRef = useRef(null);
  const risksFileInputRef = useRef(null);

  useEffect(() => {
  getConfidenceFactors()
    .then((data) => {
      const factors = data.factors || {};
      const keysRaw = Object.keys(factors);
      const keys = keysRaw.filter((k) => !EXCLUDED_FACTORS.has(k));
      setConfidenceFactors(keys);
      setConfidenceFactorMap(factors);
      setStatus("Ready ✔");
    })
    .catch((err) => {
      console.error(err);
      setStatus("Backend NOT reachable ✖");
    });
}, []);

  const confidenceSet = useMemo(() => new Set(confidenceFactors), [confidenceFactors]);

  // Ensure CBS confidenceFactor stays valid after config loads
  useEffect(() => {
    if (confidenceFactors.length === 0) return;

    const fallback = confidenceFactors.includes("Realistic") ? "Realistic" : confidenceFactors[0];

    setCbsItems((prev) =>
      prev.map((x) => {
        if (EXCLUDED_FACTORS.has(x.confidenceFactor)) return { ...x, confidenceFactor: fallback };
        if (x.confidenceFactor && !confidenceSet.has(x.confidenceFactor)) return { ...x, confidenceFactor: fallback };
        return x;
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confidenceFactors]);

  const totalBase = useMemo(() => {
    return cbsItems.reduce((sum, r) => sum + (Number(r.baseCost) || 0), 0);
  }, [cbsItems]);

  // Risk register total shown as sum of 'Most Likely ($)' for contingent risks.
  const totalRiskMostLikely = useMemo(() => {
    return risks.reduce((sum, r) => {
      const isInherent = String(r.riskType || "contingent").toLowerCase() === "inherent";
      if (isInherent) return sum;
      return sum + (Number(r.mostLikelyCost) || 0);
    }, 0);
  }, [risks]);


  // Input validation to control Run Simulation state (UI-only gate; backend still validates).
  const validationIssues = useMemo(() => {
    const issues = [];

    const isNum = (v) => typeof v === "number" ? Number.isFinite(v) : (v !== null && v !== "" && Number.isFinite(Number(v)));

    // Iterations sanity (kept lightweight)
    const it = Number(iterations);
    if (!Number.isFinite(it) || it <= 0) issues.push("Iterations must be a positive number.");
    if (Number.isFinite(it) && it > 20000) issues.push("Iterations must be 20,000 or less.");

    // CBS items
    if (!Array.isArray(cbsItems) || cbsItems.length === 0) issues.push("At least one CBS cost item is required.");
    (cbsItems || []).forEach((x, i) => {
      const row = `CBS row ${i + 1}`;
      if (!String(x.name || "").trim()) issues.push(`${row}: Name is required.`);
      if (!isNum(x.baseCost) || Number(x.baseCost) < 0) issues.push(`${row}: Base Cost must be 0 or more.`);
      if (!x.confidenceFactor) issues.push(`${row}: Confidence Factor is required.`);

      // Standard correlation requires driver group assignment
      if (String(correlationMode).toLowerCase() === "standard") {
        if (!String(x.driverGroup || "").trim()) issues.push(`${row}: Driver group is required in Standard correlation mode.`);
        const s = String(x.sensitivity || "medium").toLowerCase();
        if (!["low", "medium", "high"].includes(s)) issues.push(`${row}: Sensitivity must be Low/Medium/High.`);
      }

      if (String(x.confidenceFactor).toLowerCase() === "user defined") {
        if (!isNum(x.bestCaseCost) || Number(x.bestCaseCost) < 0) issues.push(`${row}: Best case is required (0 or more).`);
        if (!isNum(x.mostLikelyCost) || Number(x.mostLikelyCost) < 0) issues.push(`${row}: Most likely is required (0 or more).`);
        if (!isNum(x.worstCaseCost) || Number(x.worstCaseCost) < 0) issues.push(`${row}: Worst case is required (0 or more).`);

        const b = Number(x.bestCaseCost);
        const ml = Number(x.mostLikelyCost);
        const w = Number(x.worstCaseCost);
        if (Number.isFinite(b) && Number.isFinite(ml) && b > ml) issues.push(`${row}: Best case must be ≤ Most likely.`);
        if (Number.isFinite(ml) && Number.isFinite(w) && ml > w) issues.push(`${row}: Most likely must be ≤ Worst case.`);
      }
    });

    // Risks
    (risks || []).forEach((r, i) => {
      const row = `Risk row ${i + 1}`;
      if (!String(r.name || "").trim()) issues.push(`${row}: Risk name is required.`);
      const p = Number(r.probability);
      if (!Number.isFinite(p) || p < 0 || p > 1) issues.push(`${row}: Probability must be between 0 and 1.`);
      const lo = Number(r.lowCost);
      const ml = Number(r.mostLikelyCost);
      const hi = Number(r.highCost);
      if (!Number.isFinite(lo) || lo < 0) issues.push(`${row}: Low cost must be 0 or more.`);
      if (!Number.isFinite(ml) || ml < 0) issues.push(`${row}: Most likely cost must be 0 or more.`);
      if (!Number.isFinite(hi) || hi < 0) issues.push(`${row}: High cost must be 0 or more.`);
      if (Number.isFinite(lo) && Number.isFinite(ml) && lo > ml) issues.push(`${row}: Low must be ≤ Most likely.`);
      if (Number.isFinite(ml) && Number.isFinite(hi) && ml > hi) issues.push(`${row}: Most likely must be ≤ High.`);
    });

    return issues;
  }, [iterations, cbsItems, risks, correlationMode]);

  const isInputsValid = validationIssues.length === 0;


  // Cost model column widths (shrink when Standard correlation is selected to avoid horizontal scrolling)
  const isStandardCorr = correlationMode === "standard";
  const W_NAME = isStandardCorr ? 304 : 320;
  const W_BASE = isStandardCorr ? 114 : 120; // -10%
  const W_CONF = isStandardCorr ? 192 : 240; // -20%
  const W_BEST = isStandardCorr ? 114 : 120; // -10%
  const W_ML = isStandardCorr ? 114 : 120; // -10%
  const W_WORST = isStandardCorr ? 114 : 120; // -10%

  function isUserDefinedFactor(cf) {
    return String(cf || "").trim().toLowerCase() === "user defined";
  }

  function calcDerivedCosts(row) {
    // If User defined: take explicit fields
    if (isUserDefinedFactor(row.confidenceFactor)) {
      return {
        best: Number(row.bestCaseCost),
        ml: Number(row.mostLikelyCost),
        worst: Number(row.worstCaseCost),
        isDerived: false,
      };
    }

    const f = confidenceFactorMap[row.confidenceFactor];
    const base = Number(row.baseCost) || 0;
    if (!f) {
      return { best: NaN, ml: NaN, worst: NaN, isDerived: true };
    }

    const best = base * Number(f.best ?? 1);
    const ml = base * Number(f.most_likely ?? 1);
    const worst = base * Number(f.worst ?? 1);
    return { best, ml, worst, isDerived: true };
  }

  function addCbsRow() {
    const defaultFactor = confidenceFactors.includes("Realistic")
      ? "Realistic"
      : confidenceFactors[0] || "Realistic";

    cbsCounterRef.current += 1;
    const newId = makeSequentialId("cbs", cbsCounterRef.current);

    setCbsItems((prev) => [
      ...prev,
      {
        id: newId,
        name: "",
        baseCost: 0,
        confidenceFactor: defaultFactor,
        bestCaseCost: null,
        mostLikelyCost: null,
        worstCaseCost: null,
      driverGroup: "",
        sensitivity: "medium",
      },
    ]);

    resetResults();
  }

  function deleteCbsRow(id) {
    setCbsItems((prev) => prev.filter((x) => x.id !== id));
    resetResults();
  }

  function updateCbsRow(id, patch) {
    setCbsItems((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };

        // If switching to non-user-defined, clear manual fields (avoid stale data)
        if ("confidenceFactor" in patch && !isUserDefinedFactor(next.confidenceFactor)) {
          next.bestCaseCost = null;
          next.mostLikelyCost = null;
          next.worstCaseCost = null;
        }

        return next;
      })
    );
    resetResults();
  }

  function addRiskRow() {
    riskCounterRef.current += 1;
    const newId = makeSequentialId("r", riskCounterRef.current);

    setRisks((prev) => [
      ...prev,
      {
        id: newId,
        name: "",
        riskType: "contingent",
        probability: 0,
        lowCost: 0,
        mostLikelyCost: 0,
        highCost: 0,
      },
    ]);

    resetResults();
  }

  function deleteRiskRow(id) {
    setRisks((prev) => prev.filter((x) => x.id !== id));
    resetResults();
  }

  function updateRiskRow(id, patch) {
    setRisks((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, ...patch };

        // If riskType switched to inherent => zero out costs in UI
        if ("riskType" in patch && String(patch.riskType).toLowerCase() === "inherent") {
          next.lowCost = 0;
          next.mostLikelyCost = 0;
          next.highCost = 0;
        }

        return next;
      })
    );
    resetResults();
  }

  function buildPayload() {
    return {
      settings: {
        iterations: Number(iterations),
        seed: Number(seed),
        percentiles: [0.05, 0.1, 0.5, 0.9],
      },
      confidenceTableVersion: "v1",
      // Project metadata (Excel export)
      projectInfo: {
        projectName,
        projectId,
        projectManager,
        simulationDate: projectDate,
        projectNotes,
      },
      correlation_mode: correlationMode,
      cbsItems: cbsItems.map((x) => ({
        id: x.id,
        name: x.name,
        baseCost: Number(x.baseCost) || 0,
        confidenceFactor: x.confidenceFactor,
        driver_group: correlationMode === "standard" ? (x.driverGroup || null) : null,
        sensitivity: correlationMode === "standard" ? (x.sensitivity || "medium") : null,
        // backend uses these only when confidenceFactor == "User defined"
        bestCaseCost:
          x.bestCaseCost === null || x.bestCaseCost === undefined || x.bestCaseCost === ""
            ? null
            : Number(x.bestCaseCost),
        mostLikelyCost:
          x.mostLikelyCost === null || x.mostLikelyCost === undefined || x.mostLikelyCost === ""
            ? null
            : Number(x.mostLikelyCost),
        worstCaseCost:
          x.worstCaseCost === null || x.worstCaseCost === undefined || x.worstCaseCost === ""
            ? null
            : Number(x.worstCaseCost),
      })),
      contingentRisks: risks.map((r) => ({
        id: r.id,
        name: r.name,
        riskType: r.riskType || "contingent",
        probability: Number(r.probability) || 0,
        lowCost: Number(r.lowCost) || 0,
        mostLikelyCost: Number(r.mostLikelyCost) || 0,
        highCost: Number(r.highCost) || 0,
      })),
    };
  }

  async function runSimulation() {
    setErrors([]);
    resetResults();
   setIsRunning(true);

    const payload = buildPayload();

    try {
      const data = await simulate(payload);
      setResults(data.results || null);
      setSensitivity(Array.isArray(data.sensitivity) ? data.sensitivity : []);
      runCommentary(payload);
    }   catch (e) {
    console.error(e);
    setErrors(e.detail || [{ msg: "Network/API error", detail: String(e) }]);
    }  finally {
    setIsRunning(false);
    }
  }

  async function runCommentary(payloadObj) {
  setIsCommentaryRunning(true);
  setCommentaryError(null);
  setCommentary(null);
  setCommentaryMode(null);

  const payload = payloadObj ?? buildPayload();

  try {
    const data = await commentaryRun(payload);
    setCommentaryMode(data.mode_used || null);
    setCommentary(data.commentary || "");
    } catch (err) {
    console.error(err);
    setCommentaryError(String(err?.message || err));
    } finally {
    setIsCommentaryRunning(false);
    }
  }


  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  
  async function downloadJson() {
  if (!results) return;

  setErrors([]);
  setIsExporting(true);

  const payload = buildPayload();

  try {
    const blob = await exportJson(payload);
    if (!blob) return;

    const filename = `cost-risk-${safeFilename("scenario") || "scenario"}.json`;
    triggerDownload(blob, filename);
  } catch (err) {
    setErrors([err.message || "Failed to export JSON"]);
  } finally {
    setIsExporting(false);
  }
}


  async function downloadExcel() {
  if (!results) return;

  setErrors([]);
  setIsExporting(true);

  const payload = buildPayload();

  try {
    const blob = await exportExcel(payload);
    if (!blob) return;

    const filename = `cost-risk-results.xlsx`;
    triggerDownload(blob, filename);
  } catch (err) {
    setErrors([err.message || "Export Excel failed"]);
  } finally {
    setIsExporting(false);
  }
}



  // ---- CSV IMPORTS ----
  function openCbsCsvPicker() {
    setErrors([]);
    cbsFileInputRef.current?.click();
  }

  async function onCbsCsvSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const rows = parseCbsCsv(text);

      if (rows.length === 0) {
        setErrors([{ msg: "CBS import failed", detail: "No CBS names found in CSV." }]);
        return;
      }

      const defaultFactor = confidenceFactors.includes("Realistic")
        ? "Realistic" // UI label will show "Balanced Cost Range"
        : (confidenceFactors[0] || "Realistic");

      const newItems = rows.map((row, idx) => {
        const isNum = (v) => typeof v === "number" && Number.isFinite(v);
        const hasUserDefined =
          isNum(row.baseCost) &&
          isNum(row.low) &&
          isNum(row.mostLikely) &&
          isNum(row.high);

        return {
          id: makeSequentialId("cbs", idx + 1),
          name: row.name,
          // keep baseCost if provided (even when user-defined trio is present)
          baseCost: row.baseCost ?? 0,
          confidenceFactor: hasUserDefined ? "User defined" : defaultFactor,
          bestCaseCost: hasUserDefined ? Number(row.low) : null,
          mostLikelyCost: hasUserDefined ? Number(row.mostLikely) : null,
          worstCaseCost: hasUserDefined ? Number(row.high) : null,
          driverGroup: "",
          sensitivity: "medium",
        };
      });

      setCbsItems(newItems);
      cbsCounterRef.current = newItems.length;
      resetResults();
    } catch (err) {
      console.error(err);
      setErrors([{ msg: "CBS import failed", detail: String(err) }]);
    }
  }

  function openRisksCsvPicker() {
    setErrors([]);
    risksFileInputRef.current?.click();
  }

  async function onRisksCsvSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      const text = await file.text();
      const { risks: parsed, warnings } = parseRisksCsv(text);

      if (parsed.length === 0) {
        setErrors([{ msg: "Risk import failed", detail: warnings.join("\n") || "No risks parsed." }]);
        return;
      }

      const newRisks = parsed.map((r, idx) => ({
        id: makeSequentialId("r", idx + 1),
        name: r.name,
        riskType: r.riskType || "contingent",
        probability: r.probability,
        lowCost: r.lowCost,
        mostLikelyCost: r.mostLikelyCost,
        highCost: r.highCost,
      }));

      setRisks(newRisks);
      riskCounterRef.current = newRisks.length;
      resetResults();

      if (warnings.length) {
        setErrors([{ msg: "Risk import warnings (import succeeded)", detail: warnings.join("\n") }]);
      }
    } catch (err) {
      console.error(err);
      setErrors([{ msg: "Risk import failed", detail: String(err) }]);
    }
  }

  const canExport = !!results && !isRunning && !isExporting;

  const groupedSensitivity = useMemo(() => {
    const rows = Array.isArray(sensitivity) ? sensitivity : [];

    const sorted = [...rows].sort((a, b) => (Number(b.abs_rho) || 0) - (Number(a.abs_rho) || 0));
    const dominant = sorted
      .filter((x) => (Number(x.abs_rho) || 0) >= DOMINANT_MIN)
      .slice(0, MAX_PER_GROUP);

    const moderate = sorted
      .filter((x) => {
        const v = Number(x.abs_rho) || 0;
        return v >= MODERATE_MIN && v < DOMINANT_MIN;
      })
      .slice(0, MAX_PER_GROUP);

    return { dominant, moderate };
  }, [sensitivity]);

  return (
    <div className="prs-app" style={{ padding: 24, fontFamily: "Arial, sans-serif", maxWidth: 1650, margin: "0 auto" }}>
      <style>{`
    .prs-app { color: var(--text-primary); }
    .btn { padding: 8px 12px; cursor: pointer; border-radius: 8px; border: 1px solid var(--border-input); background: var(--btn-secondary-bg); color: var(--text-primary); font-weight: 600; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn:hover:not(:disabled) { background: var(--btn-secondary-hover); }

    .btnRunValid { background: var(--btn-primary-bg); border-color: var(--btn-primary-bg); color: #fff; }
    .btnRunValid:hover:not(:disabled) { background: var(--btn-primary-hover); border-color: var(--btn-primary-hover); }
    .btnRunInvalid { background: #e5e7eb; border-color: #d1d5db; color: #6b7280; }

    .iconBtn { padding: 6px 10px; cursor: pointer; border-radius: 8px; border: 1px solid var(--border-input); background: var(--btn-secondary-bg); color: var(--text-primary); font-weight: 800; line-height: 1; min-width: 40px; text-align: center; }
    .iconBtn:hover { background: var(--btn-secondary-hover); }

    .dangerBtn { border-color: var(--danger); background: #fff5f5; color: var(--danger); }
    .dangerBtn:hover { background: #ffecec; }

    .text-primary { color: var(--text-primary); }
    .text-secondary { color: var(--text-secondary); }
    .text-muted { color: var(--text-muted); }
    .text-danger { color: var(--danger); }

    code { background: rgba(0,0,0,0.06); padding: 2px 6px; border-radius: 6px; }

    .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid var(--border-input); background: #f9fafb; color: var(--text-primary); }

    html { scrollbar-gutter: stable; }
    html, body { overflow-y: scroll; }

    .tabBtnActive { background: var(--accent) !important; border-color: var(--accent) !important; color: #fff !important; }
    .tabBtnActive:hover:not(:disabled) { background: var(--accent-hover) !important; border-color: var(--accent-hover) !important; }
  `}</style>
      <header style={{ position: "sticky", top: 0, zIndex: 20, background: "var(--card-bg)", borderBottom: "1px solid var(--border-card)", paddingTop: 10, paddingBottom: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src="/PRS-logo-noBG.png"
            alt="Project Risk Solutions logo"
            style={{ height: 44, width: "auto", display: "block" }}
          />
          <div>
            <h1 style={{ margin: 0, lineHeight: 1.1 }} className="text-primary">Risk Adjusted Cost Modelling Tool</h1>
            <div className="text-secondary" style={{ marginTop: 6 }}>
              Status: <strong className="text-primary">{status}</strong>
            </div>
          </div>
        </div>
      </header>

{/* Tabs bar: sticky so navigation remains visible while scrolling */}
<div
  style={{
    position: "sticky",
    // Header is also sticky (top:0). Keep tabs pinned just below it.
    top: 78,
    zIndex: 19,
    background: "var(--page-bg)",
    borderBottom: "1px solid var(--border-card)",
    paddingTop: 10,
    paddingBottom: 10,
    marginBottom: 16,
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
  }}
>
  {[
    ["project", "Project Settings"],
    ["cost", "Cost model"],
    ["risk", "Risk register"],
    ["results", "Simulation & Results"],
  ].map(([key, label]) => (
    <button
      key={key}
      onClick={() => setActiveTab(key)}
      className={`btn ${activeTab === key ? "tabBtnActive" : ""}`}
    >
      {label}
    </button>
  ))}
</div>


      {activeTab === "project" && (
  <section style={card}>
    <h2 style={{ marginTop: 0 }} className="text-primary">Project Settings</h2>

    

    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 10, marginBottom: 14 }}>
      <div style={{ minWidth: 260, flex: "1 1 260px" }}>
        <label style={label}>Project name</label>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="e.g., Bridge Construction Project - Stage 1"
          style={input}
        />
      </div>

      <div style={{ minWidth: 220, flex: "0 0 220px" }}>
        <label style={label}>Project ID</label>
        <input
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          placeholder="e.g., PRJ-001"
          style={input}
        />
      </div>

      <div style={{ minWidth: 260, flex: "1 1 260px" }}>
        <label style={label}>Project manager</label>
        <input
          value={projectManager}
          onChange={(e) => setProjectManager(e.target.value)}
          placeholder="e.g., Sarah Smith"
          style={input}
        />
      </div>

      <div style={{ minWidth: 220, flex: "0 0 220px" }}>
        <label style={label}>Simulation date</label>
        <input
          type="date"
          value={projectDate}
          onChange={(e) => setProjectDate(e.target.value)}
          style={input}
        />
      </div>

      <div style={{ minWidth: 540, flex: "1 1 540px" }}>
        <label style={label}>Notes</label>
        <textarea
          value={projectNotes}
          onChange={(e) => setProjectNotes(e.target.value)}
          placeholder="Optional notes (e.g., scope boundaries, key assumptions, approvals) — exported later in Excel."
          style={{ ...input, height: 70, resize: "vertical" }}
        />
      </div>
    </div>
<div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <div style={{ minWidth: 220 }}>
        <label style={label}>Iterations</label>
        <input
          type="number"
          value={iterations}
          onChange={(e) => setIterations(e.target.value)}
          min="1"
          step="1"
          style={input}
        />
        <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">Tip: 5,000–10,000 is typical.</div>
      </div>

      <div style={{ minWidth: 220 }}>
        <label style={label}>Random seed</label>
        <input
          type="number"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          step="1"
          style={input}
        />
        <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">Same seed + same inputs = same results.</div>
      </div>
    </div>

    <div style={{ marginTop: 14 }}>
      <div style={{ border: "1px solid var(--border-card)", background: "var(--card-bg)", padding: 12, borderRadius: 10 }}>
        <label style={{ ...label, marginBottom: 10 }}>Correlation modelling</label>
        <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>

        <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input
            type="radio"
            name="correlationMode"
            value="none"
            checked={correlationMode === "none"}
            onChange={() => {
              setCorrelationMode("none");
              resetResults();
            }}
          />
          <span style={{ fontWeight: 700 }} className="text-primary">None</span>
          <span className="text-muted" style={{ fontSize: 12 }}>(independent)</span>
        </label>

        <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input
            type="radio"
            name="correlationMode"
            value="standard"
            checked={correlationMode === "standard"}
            onChange={() => {
              setCorrelationMode("standard");
              resetResults();
            }}
          />
          <span style={{ fontWeight: 700 }} className="text-primary">Standard</span>
          <span className="text-muted" style={{ fontSize: 12 }}>(recommended)</span>
        </label>
      </div>

      <div style={{ marginTop: 6, fontSize: 12 }} className="text-secondary">
        {correlationMode === "standard"
          ? "Assign each CBS item to a primary driver and set sensitivity. A shared driver shock is applied across CBS items."
          : "CBS items are treated as independent (no correlation)."}
              </div>
      </div>
    </div>
  </section>
)}

{/* CBS */}
      {activeTab === "cost" && (
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }} className="text-primary">Cost Breakdown Structure</h2>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button onClick={openCbsCsvPicker} className="btn" title="CSV: name + (baseCost optional) + (low/mostLikely/high optional). If low/mostLikely/high are provided, the row becomes User defined."
  >
                Import costs from CSV
              </button>
              <button onClick={addCbsRow} className="btn">+ Add Cost Row</button>
            </div>

            {!isInputsValid && (
              <div style={{ fontSize: 12, color: "var(--danger)" }}>
                Complete required Cost Model + Risk Register fields to enable Run Simulation.
              </div>
            )}
          </div>

          <input
            ref={cbsFileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={onCbsCsvSelected}
          />
        </div>

        <div style={{ marginTop: 10, marginBottom: 10 }} className="text-secondary">
          Base total: <strong className="text-primary">{money(totalBase)}</strong>
        </div>
{/* Correlation modelling (None | Standard) */}

        <div style={{ fontSize: 12, marginBottom: 10 }} className="text-muted">
          CBS CSV should contain <strong>name</strong> and optionally <strong>baseCost</strong>, and/or <strong>low / mostLikely / high</strong> (for User defined). You can modify Base Cost and Confidence Factor here.
          If you pick <span className="pill">User defined</span>, you manually enter Best/Most likely/Worst.
        </div>

        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "60vh" }}>
          <table style={{ ...table, minWidth: correlationMode === "standard" ? 1320 : 1200 }}>
            <thead>
              <tr>
                <th style={stickyTh}>ID</th>
                <th style={{ ...stickyTh, minWidth: W_NAME, width: W_NAME }}>Name</th>
                {/* Keep Base/Best/Most/Worst aligned widths for readability */}
                <th style={{ ...stickyTh, minWidth: W_BASE }}>Base Cost ($)</th>
                <th style={{ ...stickyTh, minWidth: W_CONF }}>Confidence Factor</th>
                <th style={{ ...stickyTh, minWidth: W_BEST }}>Best case</th>
                <th style={{ ...stickyTh, minWidth: W_ML }}>Most likely</th>
                <th style={{ ...stickyTh, minWidth: W_WORST }}>Worst case</th>
                {correlationMode === "standard" && <th style={{ ...stickyTh, minWidth: 160, whiteSpace: "nowrap" }}>Driver</th>}
                {/* Sensitivity column: deliberately narrower to avoid wasting space */}
                {correlationMode === "standard" && <th style={{ ...stickyTh, minWidth: 160, whiteSpace: "nowrap" }}>Sensitivity</th>}
                <th style={stickyTh}>Delete</th>
              </tr>
            </thead>
            <tbody>
              {cbsItems.map((row) => {
                const badFactor =
                  !row.confidenceFactor ||
                  EXCLUDED_FACTORS.has(row.confidenceFactor) ||
                  (confidenceFactors.length > 0 && !confidenceSet.has(row.confidenceFactor));

                const baseCostNum = Number(row.baseCost);
                const badBaseCost = Number.isNaN(baseCostNum) || baseCostNum < 0;

                const ud = isUserDefinedFactor(row.confidenceFactor);
                const derived = calcDerivedCosts(row);

                const badUD =
                  ud &&
                  !(
                    Number.isFinite(derived.best) &&
                    Number.isFinite(derived.ml) &&
                    Number.isFinite(derived.worst) &&
                    derived.best >= 0 &&
                    derived.ml >= 0 &&
                    derived.worst >= 0 &&
                    derived.best <= derived.ml &&
                    derived.ml <= derived.worst
                  );

                const derivedCellStyle = {
                  ...input,
                  background: "#f3f3f3",
                  color: "#111111",
                  WebkitTextFillColor: "#111111",
                  opacity: 1,
                };

                // For User defined, keep the same light input style as derived fields for legibility.
                const udCellStyle = {
                  ...input,
                  border: badUD ? "2px solid var(--danger)" : "1px solid #ccc",
                  background: "#f3f3f3",
                  color: "#111111",
                  WebkitTextFillColor: "#111111",
                  opacity: 1,
                };


                return (
                  <tr key={formatCbsIdDisplay(row.id)}>
                    <td style={td} className="text-secondary" title={formatCbsIdDisplay(row.id)}>{formatCbsIdDisplay(row.id)}</td>

                    <td style={td}>
                      <input
                        value={row.name}
                        onChange={(e) => updateCbsRow(row.id, { name: e.target.value })}
                        placeholder="e.g., CONSTRUCTION"
                        style={{ ...input, minWidth: 320, width: 320 }}
                      />
                    </td>

                    <td style={{ ...td, minWidth: W_BASE }}>
                      <input
                        type="number"
                        value={row.baseCost}
                        onChange={(e) => updateCbsRow(row.id, { baseCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, border: badBaseCost ? "2px solid var(--danger)" : "1px solid #ccc" }}
                        disabled={false}
                      />
                      <div style={{ fontSize: 12, marginTop: 4 }} className="text-muted">
                        {money(Number(row.baseCost) || 0)}
                      </div>
                    </td>

                    <td style={td}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <select
                        value={row.confidenceFactor}
                        onChange={(e) => updateCbsRow(row.id, { confidenceFactor: e.target.value })}
                        style={{ ...input, flex: "1 1 auto", minWidth: 220, border: badFactor ? "2px solid var(--danger)" : "1px solid #ccc" }}
                      >
                        {confidenceFactors.length === 0 ? (
                          <option value="">Loading…</option>
                        ) : (
                          confidenceFactors.map((k) => (
                            <option key={k} value={k}>{confidenceLabel(k)}</option>
                          ))
                        )}
                      </select>
                      <span
                        title={
                          row.confidenceFactor
                            ? confidenceTooltip(row.confidenceFactor)
                            : "Select a confidence factor to see help text."
                        }
                        style={{ cursor: "help", fontWeight: 900, color: "var(--text-muted)" }}
                        aria-label="Confidence factor help"
                      >
                        ⓘ
                      </span>
                    </div>
                      {badFactor && (
                        <div style={{ fontSize: 12, marginTop: 4, color: "var(--danger)" }}>
                          Choose a valid confidence factor.
                        </div>
                      )}
                      {ud && badUD && (
                        <div style={{ fontSize: 12, marginTop: 4, color: "var(--danger)" }}>
                          For User defined: ensure Best ≤ Most likely ≤ Worst and all are provided.
                        </div>
                      )}
                    </td>

                    {/* Best / Most likely / Worst */}
                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.bestCaseCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { bestCaseCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.best) ? money(derived.best) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.mostLikelyCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { mostLikelyCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.ml) ? money(derived.ml) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

                    <td style={td}>
                      {ud ? (
                        <input
                          type="number"
                          value={row.worstCaseCost ?? ""}
                          onChange={(e) => updateCbsRow(row.id, { worstCaseCost: e.target.value })}
                          min="0"
                          step="1"
                          style={udCellStyle}
                        />
                      ) : (
                        <input
                          type="text"
                          value={Number.isFinite(derived.worst) ? money(derived.worst) : ""}
                          readOnly
                          style={derivedCellStyle}
                          title="Derived from Base Cost × confidence factor"
                        />
                      )}
                    </td>

{correlationMode === "standard" && (
  <td style={td}>
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <select
        value={row.driverGroup || ""}
        onChange={(e) => updateCbsRow(row.id, { driverGroup: e.target.value })}
        style={{ ...input, minWidth: 150 }}
        title={
          row.driverGroup
            ? (DRIVER_TOOLTIPS[row.driverGroup] || "")
            : "Select the primary driver that influences this cost item."
        }
      >
        <option value="">Select driver…</option>
        {DRIVER_OPTIONS.map((d) => (
          <option key={d} value={d}>{d}</option>
        ))}
      </select>
      <span
        title={
          row.driverGroup
            ? (DRIVER_TOOLTIPS[row.driverGroup] || "")
            : "Select a driver to see help text."
        }
        style={{ cursor: "help", fontWeight: 900, color: "var(--text-muted)" }}
        aria-label="Driver help"
      >
        ⓘ
      </span>
    </div>
  </td>
)}

{correlationMode === "standard" && (
  <td style={td}>
    <div style={{ minWidth: 160, maxWidth: 176 }}>
      <input
        type="range"
        min="0"
        max="3"
        step="1"
        value={sensitivityToIndex(row.sensitivity)}
        onChange={(e) => updateCbsRow(row.id, { sensitivity: indexToSensitivity(e.target.value) })}
        style={{ width: "100%" }}
        title="Indicates how strongly this cost item responds to changes in the selected driver."
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        <span>None</span>
        <span>Low</span>
        <span>Med</span>
        <span>High</span>
      </div>
    </div>
  </td>
)}


                    <td style={td}>
                      <button onClick={() => deleteCbsRow(row.id)} className="iconBtn dangerBtn" title="Delete CBS row" aria-label="Delete CBS row">×</button>
                    </td>
                  </tr>
                );
              })}

              {cbsItems.length === 0 && (
                <tr><td style={td} colSpan={correlationMode === "standard" ? 10 : 8} className="text-secondary">No CBS rows. Import or Add.</td></tr>
              )}
            </tbody>
<tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 800 }} colSpan={2}>Total</td>
                <td style={{ ...td, fontWeight: 800 }}>{money(totalBase)}</td>
                <td style={td} colSpan={correlationMode === "standard" ? 7 : 5}></td>
              </tr>
            </tfoot>

          </table>
        </div>
      </section>
      )}


      {/* Risk Register */}
      {activeTab === "risk" && (
      <section style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }} className="text-primary">Risk register</h2>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <button onClick={openRisksCsvPicker} className="btn" title="CSV headers: name,riskType(optional),probability,lowCost,mostLikelyCost,highCost">
                Import risks from CSV
              </button>
              <button onClick={addRiskRow} className="btn">+ Add Risk</button>
            </div>

            {!isInputsValid && (
              <div style={{ fontSize: 12, color: "var(--danger)" }}>
                Complete required Cost Model + Risk Register fields to enable Run Simulation.
              </div>
            )}
          </div>

          <input
            ref={risksFileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={onRisksCsvSelected}
          />
        </div>

        <div style={{ fontSize: 12, marginTop: 10 }} className="text-muted">
          Only Event Driven (Contingent) risk costs are considered. If inherent, costs are ignored here.Adjust Base Cost variability to reflect Inherent risk impacts
        </div>

        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ ...table, minWidth: 1200 }}>
            <thead>
              <tr>
                <th style={stickyTh}>ID</th>
                <th style={{ ...stickyTh, minWidth: 360 }}>Risk</th>
                <th style={stickyTh}>Risk Type</th>
                <th style={{ ...stickyTh, fontSize: "13.5px", whiteSpace: "nowrap" }}>Probability (0–1)</th>
                <th style={stickyTh}>Low ($)</th>
                <th style={stickyTh}>Most Likely ($)</th>
                <th style={stickyTh}>High ($)</th>
                <th style={stickyTh}>Delete</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r) => {
                const p = Number(r.probability);
                const badP = Number.isNaN(p) || p < 0 || p > 1;

                const isInherent = String(r.riskType || "contingent").toLowerCase() === "inherent";

                return (
                  <tr key={r.id}>
                    <td style={td} className="text-secondary" title={r.id}>{formatRiskIdDisplay(r.id)}</td>

                    <td style={{ ...td, minWidth: 360 }}>
                      <input
                        value={r.name}
                        onChange={(e) => updateRiskRow(r.id, { name: e.target.value })}
                        placeholder="e.g., Unknown services relocation"
                        style={input}
                      />
                    </td>

                    <td style={td}>
                      <select
                        value={r.riskType || "contingent"}
                        onChange={(e) => updateRiskRow(r.id, { riskType: e.target.value })}
                        style={input}
                      >
                        <option value="contingent">contingent</option>
                        <option value="inherent">inherent</option>
                      </select>
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.probability}
                        onChange={(e) => updateRiskRow(r.id, { probability: e.target.value })}
                        min="0"
                        max="1"
                        step="0.01"
                        style={{ ...input, border: badP ? "2px solid var(--danger)" : "1px solid #ccc" }}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.lowCost}
                        onChange={(e) => updateRiskRow(r.id, { lowCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.mostLikelyCost}
                        onChange={(e) => updateRiskRow(r.id, { mostLikelyCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <input
                        type="number"
                        value={r.highCost}
                        onChange={(e) => updateRiskRow(r.id, { highCost: e.target.value })}
                        min="0"
                        step="1"
                        style={{ ...input, background: isInherent ? "#f3f3f3" : input.background }}
                        disabled={isInherent}
                      />
                    </td>

                    <td style={td}>
                      <button onClick={() => deleteRiskRow(r.id)} className="iconBtn dangerBtn" title="Delete risk" aria-label="Delete risk">×</button>
                    </td>
                  </tr>
                );
              })}

              {risks.length === 0 && (
                <tr><td style={td} colSpan={8} className="text-secondary">No risks. Import or Add.</td></tr>
              )}
            </tbody>
<tfoot>
              <tr>
                <td style={{ ...td, fontWeight: 800 }} colSpan={5}>Total (Most likely)</td>
                <td style={{ ...td, fontWeight: 800 }}>{money(totalRiskMostLikely)}</td>
                <td style={td} colSpan={2}></td>
              </tr>
            </tfoot>

          </table>
        </div>
      </section>
      )}


      {/* Simulation */}
      {activeTab === "results" && (
      <section style={card}>
        <h2 style={{ marginTop: 0 }} className="text-primary">Simulation</h2>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
            <button
              onClick={runSimulation}
              className={`btn ${isInputsValid ? "btnRunValid" : "btnRunInvalid"}`}
              style={{ minWidth: 192, padding: "12px 20px", fontSize: 18 }}
              disabled={isRunning || isExporting || !isInputsValid}
            >
              {isRunning ? "Running…" : "Run Simulation"}
            </button>
            {!isInputsValid && (
              <div style={{ fontSize: 12, color: "var(--danger)" }}>
                Complete required Cost Model + Risk Register fields to enable Run Simulation.
              </div>
            )}
          </div>
        </div>

        {errors.length > 0 && (
          <div style={{ background: "#fff3f3", border: "1px solid #f3b5b5", padding: 12, borderRadius: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--danger)" }}>Validation / API errors / import warnings</div>
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{JSON.stringify(errors, null, 2)}</pre>
          </div>
        )}

        {results ? (
  <div
    style={{
      marginTop: 12,
      background: "var(--card-bg)",
      border: "1px solid var(--border-card)",
      padding: 12,
      borderRadius: 8,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ fontWeight: 700 }} className="text-primary">Results ($)</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn" onClick={downloadJson} disabled={!canExport}>
          {isExporting ? "Exporting…" : "Download JSON"}
        </button>
        <button className="btn" onClick={downloadExcel} disabled={!canExport}>
          {isExporting ? "Exporting…" : "Download Excel"}
        </button>
      </div>
    </div>

    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
      <ResultBox label="P5" value={money(results.p5)} />
      <ResultBox label="P10" value={money(results.p10)} />
      <ResultBox label="P50" value={money(results.p50)} />
      <ResultBox label="P90" value={money(results.p90)} />
      <ResultBox
        label="Contingency (P90−P50)"
        value={money(results.contingency_p90_minus_p50)}
      />
    </div>

    {/* --- Sensitivity (Grouped, short) --- */}
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 800, marginBottom: 8 }} className="text-primary">
        Sensitivity (Top drivers)
      </div>

      {(!sensitivity || sensitivity.length === 0) ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          No sensitivity data returned. (Make sure your backend /simulate is returning <code>sensitivity</code>.)
        </div>
      ) : (
        (() => {
          // Grouping logic: "Dominant" >= 0.30 abs_rho, "Moderate" 0.15–0.30
          const dom = sensitivity.filter((d) => Number(d.abs_rho) >= 0.30).slice(0, 8);
          const mod = sensitivity
            .filter((d) => Number(d.abs_rho) >= 0.15 && Number(d.abs_rho) < 0.30)
            .slice(0, 10);

          
          const resolveDisplayName = (row) => {
            if (row.category === "RISK") {
              const r = risks.find(x => x.id === row.name);
              return r ? r.name : row.name;
            }
            if (row.category === "CBS") {
              const c = cbsItems.find(x => x.id === row.name);
              return c ? c.name : row.name;
            }
            return row.name;
          };

const renderTable = (title, rows) => (
            <div style={{ marginTop: 10 }}>
              {/* Ensure legible text on light Results panel */}
              {/* Table defaults to dark-theme text in some browsers; force dark text here */}

              <div style={{ fontWeight: 700, marginBottom: 6 }} className="text-primary">
                {title}{" "}
                <span style={{ fontWeight: 600, color: "var(--text-muted)", fontSize: 12 }}>
                  ({rows.length})
                </span>
              </div>

              {rows.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>None</div>
              ) : (
                <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "60vh" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <th style={stickyTh}>Rank</th>
                        <th style={stickyTh}>Driver</th>
                        <th style={stickyTh}>Category</th>
                        <th style={stickyTh}>Direction</th>
                        <th style={stickyTh}>|ρ|</th>
</tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const abs = Number(r.abs_rho) || 0;
                        const rho = Number(r.spearman_rho) || 0;
                        const sign = rho >= 0 ? "+" : "-";
                        return (
                          <tr key={`${title}-${r.name}-${i}`}>
                            <td style={td}>{i + 1}</td>
                            <td style={td}>
                              <div style={{ fontWeight: 800, color: "var(--text-primary)" }}>
                                {resolveDisplayName(r)}
                              </div>
                              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                                {r.category === "RISK" ? formatRiskIdDisplay(r.name) : r.category === "CBS" ? formatCbsIdDisplay(r.name) : String(r.name || "").toUpperCase()}
                              </div>
                            </td>
                            <td style={td}>{r.category}</td>
                            <td style={td}>
                              <span style={{ fontWeight: 800 }} className="text-primary">
                                {sign}
                              </span>
                            </td>
                            <td style={td}>{abs.toFixed(3)}</td>
                            </tr>
                        );
                      })}
                    </tbody>


                  </table>
                </div>
              )}
            </div>
          );

          return (
            <div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                Grouping rules: <strong>Dominant</strong> (|ρ| ≥ 0.30),{" "}
                <strong>Moderate</strong> (0.15 ≤ |ρ| &lt; 0.30). (Spearman rank correlation.)
              </div>

              {renderTable("Dominant drivers", dom)}
              {renderTable("Moderately dominant drivers", mod)}
            </div>
          );
        })()
      )}
    </div>

    <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-secondary)" }}>
          {/* --- Commentary (AI) --- */}
    <div style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 800, marginBottom: 8 }} className="text-primary">
        Commentary {commentaryMode ? <span className="pill">{commentaryMode}</span> : null}
      </div>

      {isCommentaryRunning ? (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>Generating commentary…</div>
      ) : commentary ? (
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.35 }} className="text-primary">
          {commentary}
        </pre>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Commentary will appear here after you run a simulation.
        </div>
      )}

      {commentaryError ? (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger)" }}>
          Commentary error: {commentaryError}
        </div>
      ) : null}
    </div>
      Downloads are enabled only after running a simulation.
    </div>
  </div>
) : (
  <div style={{ marginTop: 12, fontSize: 12 }} className="text-muted">
    {isRunning ? "Running simulation…" : "No results yet. Click Run Simulation."}
  </div>
)}

      </section>
      )}

    </div>
  );
}

function ResultBox({ label, value }) {
  return (
    <div
      style={{ border: "1px solid var(--border-card)", borderRadius: 10, padding: 12, minWidth: 180, background: "var(--card-bg)" }}
    >
      <div style={{ fontSize: 12 }} className="text-secondary">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, marginTop: 6 }} className="text-primary">
        {value}
      </div>
    </div>
  );
}

// Keep panel geometry consistent across tabs to avoid perceived layout "jump".
// Cost model is naturally taller; this minHeight gives the other tabs a similar canvas.
const card = {
  background: "var(--card-bg)",
  border: "1px solid var(--border-card)",
  boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
  borderRadius: 10,
  padding: 16,
  marginBottom: 18,
  width: "100%",
  boxSizing: "border-box",
  minHeight: 640,
  minWidth: 1200,
};

const table = { width: "100%", borderCollapse: "collapse", background: "var(--table-bg)" };

const th = {
  textAlign: "left",
  borderBottom: "1px solid var(--border-card)",
  padding: "12px 10px",
  background: "var(--table-head-bg)",
  color: "var(--text-primary)",
  fontWeight: 700,
  fontSize: 13,
};

const stickyTh = {
  ...th,
  position: "sticky",
  top: 0,
  zIndex: 3,
};

const td = {
  borderBottom: "1px solid var(--border-card)",
  padding: "12px 10px",
  verticalAlign: "top",
  color: "var(--text-primary)",
};

const input = {
  width: "100%",
  padding: 8,
  border: "1px solid var(--border-input)",
  borderRadius: 8,
  boxSizing: "border-box",
  background: "var(--input-bg)",
  color: "var(--text-primary)",
};

const label = { display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 6 };

export default App;

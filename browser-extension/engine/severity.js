// engine/severity.js — pure-JS port of src/app/services/severity.py.
"use strict";

(function attach(root) {
  const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

  const LABEL_TO_SEVERITY = {
    // ---- critical -------------------------------------------------------
    MY_NUMBER: "critical",
    PASSPORT: "critical",
    DRIVERS_LICENSE: "critical",
    CREDIT_CARD: "critical",
    BANK_ACCOUNT: "critical",
    API_KEY: "critical",
    SECRET: "critical",
    DB_CONNECTION: "critical",
    // ---- high -----------------------------------------------------------
    PERSON: "high",
    PROPER_NOUN_PERSON: "high",
    JP_SURNAME: "high",
    WESTERN_FIRST_NAME: "high",
    EMAIL_ADDRESS: "high",
    PHONE_NUMBER: "high",
    ADDRESS: "high",
    PATIENT_ID: "high",
    // ---- medium ---------------------------------------------------------
    LOCATION: "medium",
    PROPER_NOUN_LOCATION: "medium",
    PREFECTURE_CITY: "medium",
    JP_PREFECTURE_DICT: "medium",
    JP_DESIGNATED_CITY: "medium",
    WORLD_COUNTRY: "medium",
    PROPER_NOUN_ORG: "medium",
    ORGANIZATION: "medium",
    COMPANY: "medium",
    COMPANY_ABBREV: "low",
    EMPLOYEE_ID: "medium",
    MEMBER_ID: "medium",
    CUSTOMER_ID: "medium",
    CONTRACT_NUMBER: "medium",
    PURCHASE_ORDER: "medium",
    INVOICE_NUMBER: "medium",
    INTERNAL_ID: "medium",
    DEPARTMENT: "medium",
    ASSET_NUMBER: "medium",
    LICENSE_NUMBER: "medium",
    PATENT_NUMBER: "medium",
    MONETARY_AMOUNT: "medium",
    ANNUAL_INCOME: "medium",
    URL: "medium",
    IP_ADDRESS: "medium",
    // ---- low ------------------------------------------------------------
    AGE: "low",
    GENDER: "low",
    DATE: "low",
    BLOOD_TYPE: "low",
    POSTAL_CODE: "low",
    SKU: "low",
    KATAKANA_NAME: "low",
    // USER_DEFINED_* — user-selected category maps to the category's
    BUSINESS_CONFIDENTIAL: "high",
    CORPORATE_NUMBER: "medium",
    INVOICE_REG_NUMBER: "medium",
    MAC_ADDRESS: "medium",
    IP_CIDR: "medium",
    INTERNAL_HOSTNAME: "medium",
    IBAN: "critical",
    US_SSN: "critical",
    UK_NINO: "critical",
    CRYPTO_ADDRESS: "critical",
    EMAIL_HEADER: "high",
    COOKIE_HEADER: "critical",
    LOCAL_USER_PATH: "medium",
    PII_JSON_FIELD: "high",
    // default severity (PERSON→high, CREDENTIAL→critical, etc.).
    USER_DEFINED_PERSON: "high",
    USER_DEFINED_LOCATION: "medium",
    USER_DEFINED_ORGANIZATION: "medium",
    USER_DEFINED_CONTACT: "high",
    USER_DEFINED_FINANCIAL: "critical",
    USER_DEFINED_CREDENTIAL: "critical",
    USER_DEFINED_IDENTITY: "low",
    USER_DEFINED_INTERNAL_ID: "medium",
    USER_DEFINED_OTHER: "medium",
  };

  function severityFor(label) {
    return Object.prototype.hasOwnProperty.call(LABEL_TO_SEVERITY, label)
      ? LABEL_TO_SEVERITY[label]
      : "low";
  }

  // Surface patterns that escalate to ``critical``. Mirrors
  // app/services/severity.py:severity_for_surface so the standalone
  // engine and gateway agree on the same risk tier.
  const FORMAL_COMPANY_RE = /(株式会社|㈱|有限会社|㈲|合同会社|合資会社)/;
  const EMAIL_WITH_DOMAIN_RE = /[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}/;

  const PERSON_FP_TOKENS = [
    "ます", "ません", "ください", "いたします", "致します", "願い",
    "注意", "確認", "ご了承", "申し訳", "ありがと", "よろしく",
    "とおり", "ように", "ような", "については", "ところ", "ため",
    "こと", "もの", "それ", "これ", "あれ",
  ];

  function isFalsePositivePerson(surface) {
    if (!surface || surface.length <= 6) return false;
    return PERSON_FP_TOKENS.some((tok) => surface.indexOf(tok) !== -1);
  }

  function severityForSurface(label, surface) {
    if (label === "PERSON" || label === "PROPER_NOUN_PERSON") return "critical";
    if (label === "ORGANIZATION" || label === "COMPANY" || label === "PROPER_NOUN_ORG") {
      if (surface && FORMAL_COMPANY_RE.test(surface)) return "critical";
    }
    if (label === "EMAIL_ADDRESS") {
      if (surface && EMAIL_WITH_DOMAIN_RE.test(surface)) return "critical";
    }
    return severityFor(label);
  }

  function maxSeverity(severities) {
    const order = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i]));
    let best = "low", bestRank = order.low;
    for (const sev of severities || []) {
      const r = Object.prototype.hasOwnProperty.call(order, sev) ? order[sev] : order.low;
      if (r < bestRank) { best = sev; bestRank = r; }
    }
    return best;
  }

  const api = { SEVERITY_ORDER, LABEL_TO_SEVERITY, severityFor, severityForSurface, maxSeverity, isFalsePositivePerson };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { severity: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);

// engine/classification.js — pure-JS port of src/app/services/classification.py.
"use strict";

(function attach(root) {
  const KNOWN_CLASSIFICATIONS = [
    "proper_noun",
    "contact",
    "identifier",
    "credential",
    "attribute",
    "other",
    // 文単位の「意味として機密」判定 (confidential.js)。
    // span 検出ではないので既存クラスに混ぜず独立させる。
    "semantic",
  ];

  const LABEL_TO_CLASSIFICATION = {
    // ---- proper_noun ----------------------------------------------------
    PERSON: "proper_noun",
    PROPER_NOUN_PERSON: "proper_noun",
    KATAKANA_NAME: "proper_noun",
    JP_SURNAME: "proper_noun",
    WESTERN_FIRST_NAME: "proper_noun",
    LOCATION: "proper_noun",
    PROPER_NOUN_LOCATION: "proper_noun",
    ORGANIZATION: "proper_noun",
    PROPER_NOUN_ORG: "proper_noun",
    COMPANY: "proper_noun",
    COMPANY_ABBREV: "proper_noun",
    // ---- contact --------------------------------------------------------
    EMAIL_ADDRESS: "contact",
    PHONE_NUMBER: "contact",
    URL: "contact",
    IP_ADDRESS: "contact",
    ADDRESS: "contact",
    PREFECTURE_CITY: "contact",
    JP_PREFECTURE_DICT: "contact",
    JP_DESIGNATED_CITY: "contact",
    WORLD_COUNTRY: "contact",
    POSTAL_CODE: "contact",
    // ---- identifier -----------------------------------------------------
    EMPLOYEE_ID: "identifier",
    MEMBER_ID: "identifier",
    CUSTOMER_ID: "identifier",
    PATIENT_ID: "identifier",
    CONTRACT_NUMBER: "identifier",
    PURCHASE_ORDER: "identifier",
    INVOICE_NUMBER: "identifier",
    INTERNAL_ID: "identifier",
    DEPARTMENT: "identifier",
    // USER_DEFINED_* — classification は category 系統を踏襲。
    BUSINESS_CONFIDENTIAL: "semantic",
    CORPORATE_NUMBER: "identifier",
    INVOICE_REG_NUMBER: "identifier",
    MAC_ADDRESS: "identifier",
    IP_CIDR: "identifier",
    INTERNAL_HOSTNAME: "identifier",
    IBAN: "credential",
    US_SSN: "credential",
    UK_NINO: "credential",
    CRYPTO_ADDRESS: "credential",
    EMAIL_HEADER: "contact",
    COOKIE_HEADER: "credential",
    LOCAL_USER_PATH: "identifier",
    PII_JSON_FIELD: "contact",
    USER_DEFINED_PERSON: "proper_noun",
    USER_DEFINED_LOCATION: "contact",
    USER_DEFINED_ORGANIZATION: "proper_noun",
    USER_DEFINED_CONTACT: "contact",
    USER_DEFINED_FINANCIAL: "identifier",
    USER_DEFINED_CREDENTIAL: "credential",
    USER_DEFINED_IDENTITY: "attribute",
    USER_DEFINED_INTERNAL_ID: "identifier",
    USER_DEFINED_OTHER: "other",
    SKU: "identifier",
    ASSET_NUMBER: "identifier",
    LICENSE_NUMBER: "identifier",
    PATENT_NUMBER: "identifier",
    DB_CONNECTION: "identifier",
    // ---- credential -----------------------------------------------------
    API_KEY: "credential",
    SECRET: "credential",
    MY_NUMBER: "credential",
    DRIVERS_LICENSE: "credential",
    PASSPORT: "credential",
    CREDIT_CARD: "credential",
    BANK_ACCOUNT: "credential",
    // ---- attribute ------------------------------------------------------
    AGE: "attribute",
    GENDER: "attribute",
    DATE: "attribute",
    BLOOD_TYPE: "attribute",
    MONETARY_AMOUNT: "attribute",
    ANNUAL_INCOME: "attribute",
  };

  function classificationFor(label) {
    return Object.prototype.hasOwnProperty.call(LABEL_TO_CLASSIFICATION, label)
      ? LABEL_TO_CLASSIFICATION[label]
      : "other";
  }
  function defaultEnabledClasses() { return KNOWN_CLASSIFICATIONS.slice(); }

  const api = { KNOWN_CLASSIFICATIONS, LABEL_TO_CLASSIFICATION, classificationFor, defaultEnabledClasses };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { classification: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);

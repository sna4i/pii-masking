// engine/categories.js — pure-JS port of src/app/services/category_map.py.
"use strict";

(function attach(root) {
  const LABEL_TO_CATEGORY = {
    // PERSON
    PERSON: "PERSON",
    PROPER_NOUN_PERSON: "PERSON",
    KATAKANA_NAME: "PERSON",
    JP_SURNAME: "PERSON",
    WESTERN_FIRST_NAME: "PERSON",
    // LOCATION
    LOCATION: "LOCATION",
    PROPER_NOUN_LOCATION: "LOCATION",
    ADDRESS: "LOCATION",
    PREFECTURE_CITY: "LOCATION",
    JP_PREFECTURE_DICT: "LOCATION",
    JP_DESIGNATED_CITY: "LOCATION",
    WORLD_COUNTRY: "LOCATION",
    // ORGANIZATION
    ORGANIZATION: "ORGANIZATION",
    PROPER_NOUN_ORG: "ORGANIZATION",
    COMPANY: "ORGANIZATION",
    COMPANY_ABBREV: "ORGANIZATION",
    DEPARTMENT: "ORGANIZATION",
    // CONTACT
    EMAIL_ADDRESS: "CONTACT",
    PHONE_NUMBER: "CONTACT",
    URL: "CONTACT",
    IP_ADDRESS: "CONTACT",
    POSTAL_CODE: "CONTACT",
    // FINANCIAL
    CREDIT_CARD: "FINANCIAL",
    BANK_ACCOUNT: "FINANCIAL",
    MONETARY_AMOUNT: "FINANCIAL",
    ANNUAL_INCOME: "FINANCIAL",
    INVOICE_NUMBER: "FINANCIAL",
    // CREDENTIAL
    API_KEY: "CREDENTIAL",
    SECRET: "CREDENTIAL",
    MY_NUMBER: "CREDENTIAL",
    DRIVERS_LICENSE: "CREDENTIAL",
    PASSPORT: "CREDENTIAL",
    DB_CONNECTION: "CREDENTIAL",
    LICENSE_NUMBER: "CREDENTIAL",
    // IDENTITY
    AGE: "IDENTITY",
    GENDER: "IDENTITY",
    DATE: "IDENTITY",
    BLOOD_TYPE: "IDENTITY",
    // INTERNAL_ID
    INTERNAL_ID: "INTERNAL_ID",
    EMPLOYEE_ID: "INTERNAL_ID",
    CONTRACT_NUMBER: "INTERNAL_ID",
    PURCHASE_ORDER: "INTERNAL_ID",
    CUSTOMER_ID: "INTERNAL_ID",
    PATIENT_ID: "INTERNAL_ID",
    MEMBER_ID: "INTERNAL_ID",
    SKU: "INTERNAL_ID",
    PATENT_NUMBER: "INTERNAL_ID",
    ASSET_NUMBER: "INTERNAL_ID",
    // USER_DEFINED_* — drop-registered user force-mask list.
    // ---- v1.3.1 で追加した検出ラベル ----
    BUSINESS_CONFIDENTIAL: "OTHER",
    SCHOOL_NAME: "LOCATION",
    DEVICE_ID: "INTERNAL_ID",
    CORPORATE_NUMBER: "ORGANIZATION",
    INVOICE_REG_NUMBER: "FINANCIAL",
    MAC_ADDRESS: "CONTACT",
    IP_CIDR: "CONTACT",
    INTERNAL_HOSTNAME: "CONTACT",
    IBAN: "FINANCIAL",
    US_SSN: "CREDENTIAL",
    UK_NINO: "CREDENTIAL",
    CRYPTO_ADDRESS: "FINANCIAL",
    EMAIL_HEADER: "CONTACT",
    COOKIE_HEADER: "CREDENTIAL",
    LOCAL_USER_PATH: "IDENTITY",
    PII_JSON_FIELD: "OTHER",

    // label の suffix がそのまま big category キーになる。
    USER_DEFINED_PERSON: "PERSON",
    USER_DEFINED_LOCATION: "LOCATION",
    USER_DEFINED_ORGANIZATION: "ORGANIZATION",
    USER_DEFINED_CONTACT: "CONTACT",
    USER_DEFINED_FINANCIAL: "FINANCIAL",
    USER_DEFINED_CREDENTIAL: "CREDENTIAL",
    USER_DEFINED_IDENTITY: "IDENTITY",
    USER_DEFINED_INTERNAL_ID: "INTERNAL_ID",
    USER_DEFINED_OTHER: "OTHER",
  };

  function categoryFor(label) {
    return Object.prototype.hasOwnProperty.call(LABEL_TO_CATEGORY, label)
      ? LABEL_TO_CATEGORY[label]
      : "OTHER";
  }
  const api = { LABEL_TO_CATEGORY, categoryFor };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") {
    root.__localMaskMCP = root.__localMaskMCP || {};
    root.__localMaskMCP.engine = root.__localMaskMCP.engine || {};
    Object.assign(root.__localMaskMCP.engine, { categories: api });
  }
})(typeof window !== "undefined" ? window : typeof self !== "undefined" ? self : globalThis);

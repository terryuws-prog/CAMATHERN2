import assert from "node:assert/strict";
import test from "node:test";
import { translations } from "../assets/src/i18n.js";

test("English and Welsh dictionaries cover every dashboard key", () => {
  const englishKeys = Object.keys(translations.en).sort();
  const welshKeys = Object.keys(translations.cy).sort();

  assert.deepEqual(welshKeys, englishKeys);
  assert.equal(translations.cy["kpi.helper.valid"], "QC gwyrdd");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NICKNAME_INPUT_PLACEHOLDER,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  validateNickname,
} from "../../src/lib/validation/nickname";

let checks = 0;
function check(condition: unknown, message: string) {
  assert.ok(condition, message);
  checks += 1;
}

check(NICKNAME_MIN_LENGTH === 2, "minimum nickname length must remain 2");
check(NICKNAME_MAX_LENGTH === 8, "maximum nickname length must be 8");
check(NICKNAME_INPUT_PLACEHOLDER === "닉네임 (2~8자)", "input copy must expose the 2~8 limit");
check(validateNickname("가나") === null, "2-character nickname must be valid");
check(validateNickname("가나다라마바사아") === null, "8-character nickname must be valid");
check(validateNickname("가나다라마바사아자") === "닉네임은 2~8자로 입력해주세요", "9-character nickname must be rejected");
check(validateNickname("가 나") === "한글, 영문, 숫자만 사용 가능합니다", "invalid characters must remain rejected");

const setupRoute = readFileSync("src/app/api/setup/route.ts", "utf8");
const setupValidation = setupRoute.indexOf("validateNickname(trimmedNickname)");
const setupWrite = setupRoute.indexOf('.from("profiles").insert');
check(setupValidation >= 0 && setupValidation < setupWrite, "signup API must validate before writing profiles");

for (const file of [
  "src/components/auth/ProfileSetupModal.tsx",
  "src/app/setup/page.tsx",
  "src/components/profile/NicknameEditSheet.tsx",
]) {
  const source = readFileSync(file, "utf8");
  check(source.includes("NICKNAME_MAX_LENGTH"), `${file} must use the shared maxLength`);
  check(source.includes("validateNickname"), `${file} must use shared validation`);
  check(!source.includes("2~12"), `${file} must not retain the old 12-character copy`);
}

for (const file of [
  "src/app/api/setup/route.ts",
  "src/app/api/check-nickname/route.ts",
  "src/app/api/me/nickname/route.ts",
]) {
  const source = readFileSync(file, "utf8");
  check(source.includes("validateNickname"), `${file} must enforce shared validation`);
}

console.log(`PASS — ${checks}/${checks}`);

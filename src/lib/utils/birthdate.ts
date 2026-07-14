/**
 * 선수 생년월일 표시 유틸.
 * roster의 birthDate(ISO "2000-07-17") → "2000.07.17 · 만 25세".
 * 값 없거나 형식 불일치면 null (호출측에서 미표시).
 */
export function formatBirthDisplay(iso?: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;

  const now = new Date();
  const nowMonth = now.getMonth() + 1;
  const birthMonth = Number(mo);
  const birthDay = Number(d);
  let age = now.getFullYear() - Number(y);
  const hadBirthday =
    nowMonth > birthMonth || (nowMonth === birthMonth && now.getDate() >= birthDay);
  if (!hadBirthday) age -= 1;

  // 방어: 파싱 이상값이면 나이 생략하고 날짜만.
  if (age < 0 || age > 120) return `${y}.${mo}.${d}`;
  return `${y}.${mo}.${d} · 만 ${age}세`;
}

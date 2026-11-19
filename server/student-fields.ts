// These rules run in the browser and on the server.
export const fieldLengths = { name: 120, roll: 80, department: 100, semester: 80, mobile: 30, category: 100 }
export const MAX_FILE = 5 * 1024 * 1024

function trim(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

export function normalizeRoll(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

export function normalizeMobile(value: string) {
  const compact = value.normalize('NFKC').replace(/[\s()-]/gu, '')
  const match = /^(?:0|\+92)(3\d{9})$/.exec(compact)
  return match ? `+92${match[1]}` : null
}

export function validateStudentFields(body: Record<string, unknown>) {
  const name = trim(body.name)
  const roll = trim(body.roll)
  const department = trim(body.department)
  const semester = trim(body.semester)
  const category = trim(body.category)
  const mobileInput = trim(body.mobile)
  const mobile = normalizeMobile(mobileInput)
  const errors: Record<string, string> = {}
  if (!/\p{L}/u.test(name) || name.length > fieldLengths.name || /\p{Cc}/u.test(name)) {
    errors.name = 'Enter your complete name using up to 120 characters.'
  }
  if (!/[\p{L}\p{N}]/u.test(roll) || roll.length > fieldLengths.roll || /\p{Cc}/u.test(roll)) {
    errors.roll = 'Enter your complete roll number using up to 80 characters.'
  }
  if (!department || department.length > fieldLengths.department || /\p{Cc}/u.test(department)) {
    errors.department = 'Enter your department using up to 100 characters.'
  }
  if (!semester || semester.length > fieldLengths.semester || /\p{Cc}/u.test(semester)) {
    errors.semester = 'Enter your semester using up to 80 characters.'
  }
  if (!mobile || mobileInput.length > fieldLengths.mobile) {
    errors.mobile = 'Enter a Pakistani mobile number, such as 0300 1234567 or +92 300 1234567.'
  }
  if ((body.category !== undefined && typeof body.category !== 'string') ||
      category.length > fieldLengths.category || /\p{Cc}/u.test(category)) {
    errors.category = 'Enter a category using up to 100 characters, or leave it blank.'
  }
  return { fields: { name, roll, department, semester, mobile: mobile ?? '', category: category || 'Not specified' }, errors }
}

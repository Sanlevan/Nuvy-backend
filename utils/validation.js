function cleanString(str, maxLength = 100) {
    if (typeof str !== 'string') return '';
    return str.trim().slice(0, maxLength);
}

function isValidPhone(tel) {
    if (typeof tel !== 'string') return false;
    const clean = tel.replace(/[^\d+]/g, '');
    return /^(\+?\d{8,15}|0[1-9]\d{8})$/.test(clean);
}

function isValidInteger(val) {
    const n = parseInt(val);
    return !isNaN(n) && n >= -100 && n <= 100;
}

module.exports = { cleanString, isValidPhone, isValidInteger };

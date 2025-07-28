function getAllTextIn(text, start, end) {
    const startIndex = text.indexOf(start);
    if (startIndex === -1) {
        return '';
    }
    
    const searchStart = startIndex + start.length;
    const endIndex = text.indexOf(end, searchStart);
    if (endIndex === -1) {
        return '';
    }
    
    return text.substring(searchStart, endIndex);
}

module.exports = getAllTextIn;
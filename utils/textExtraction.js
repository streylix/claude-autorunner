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

// New function to get only the last occurrence between start and end characters
function getLastTextIn(text, start, end) {
    const lastStartIndex = text.lastIndexOf(start);
    if (lastStartIndex === -1) {
        return '';
    }
    
    const searchStart = lastStartIndex + start.length;
    const endIndex = text.indexOf(end, searchStart);
    if (endIndex === -1) {
        return '';
    }
    
    return text.substring(searchStart, endIndex);
}

// Function to clean up terminal output text by removing control characters and formatting
function cleanTerminalText(text) {
    if (!text) return '';
    
    // Remove ANSI escape sequences and control characters
    let cleaned = text
        // Remove ANSI escape sequences (colors, formatting, etc.)
        .replace(/\x1b\[[0-9;]*[mGKHfJD]/g, '')
        // Remove other control characters except newlines and tabs
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
        // Remove HTML-like tags that appear in terminal output
        .replace(/<[^>]*>/g, '')
        // Clean up excessive whitespace while preserving line breaks
        .replace(/[ \t]+/g, ' ')
        // Remove leading/trailing whitespace from each line
        .split('\n').map(line => line.trim()).join('\n')
        // Remove excessive blank lines (more than 2 consecutive)
        .replace(/\n{3,}/g, '\n\n')
        // Remove leading and trailing blank lines
        .trim();
    
    return cleaned;
}

module.exports = {
    getAllTextIn,
    getLastTextIn,
    cleanTerminalText
};
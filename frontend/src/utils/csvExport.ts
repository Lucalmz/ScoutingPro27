export function downloadCSV(filename: string, headers: string[], rows: any[][]) {
  const processRow = (row: any[]) => {
    return row.map(val => {
      if (val === null || val === undefined) return '""';
      
      let str = String(val);
      
      // Prevent CSV Injection (Formula Injection)
      // Only apply to actual strings, so we don't ruin legitimate negative numbers (e.g. -5.2)
      if (typeof val === 'string' && /^[=+\-@]/.test(str)) {
        // Double check it's not just a valid string-encoded number
        if (isNaN(Number(str))) {
          str = "'" + str;
        }
      }
      
      // Escape quotes
      if (str.includes('"')) {
        str = str.replace(/"/g, '""');
      }
      // Wrap in quotes if it contains comma, newline, or quotes
      if (str.includes(',') || str.includes('\n') || str.includes('"')) {
        str = `"${str}"`;
      }
      return str;
    }).join(',');
  };

  const csvContent = [
    processRow(headers),
    ...rows.map(processRow)
  ].join('\n');

  // Add BOM for Excel UTF-8 support
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const link = document.createElement('a');
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

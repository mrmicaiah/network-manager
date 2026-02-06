import { useState, useCallback, useRef } from 'react';
import { useApi, useLazyApi } from '../hooks/useApi';
import {
  Upload,
  FileSpreadsheet,
  Download,
  Check,
  X,
  AlertCircle,
  Loader2,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Smartphone,
  FileText,
} from 'lucide-react';

// ===========================================================================
// Types
// ===========================================================================

interface Circle {
  id: string;
  name: string;
}

interface ParsedRow {
  name: string;
  phone: string;
  email: string;
  notes: string;
  rawRow: Record<string, string>;
  isValid: boolean;
  error?: string;
}

interface ImportResponse {
  imported: number;
  duplicatesSkipped: number;
  invalidRows: number;
  contactIds: string[];
  errors?: Array<{ row: number; reason: string; data: Record<string, string> }>;
  format: 'csv' | 'vcard';
}

type ViewState = 'upload' | 'preview' | 'importing' | 'complete';

// ===========================================================================
// CSV Template
// ===========================================================================

const CSV_TEMPLATE = `name,phone,email,notes
John Smith,+15551234567,john@example.com,Met at conference
Jane Doe,+15559876543,jane@example.com,College friend
Bob Wilson,,bob@company.com,Work colleague`;

// ===========================================================================
// Component
// ===========================================================================

export function ImportPage() {
  const [viewState, setViewState] = useState<ViewState>('upload');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string>('');
  const [importResult, setImportResult] = useState<ImportResponse | null>(null);
  const [importProgress, setImportProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileType, setFileType] = useState<'csv' | 'vcf' | null>(null);
  const [rawFileContent, setRawFileContent] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: circles } = useApi<Circle[]>('/api/circles');
  const { execute: uploadFile } = useLazyApi<ImportResponse>();

  // Download CSV template
  const handleDownloadTemplate = () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bethany-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Parse file for preview
  const parseFileForPreview = useCallback((text: string, isVCard: boolean): ParsedRow[] => {
    if (isVCard) {
      return parseVCardForPreview(text);
    } else {
      return parseCSVForPreview(text);
    }
  }, []);

  // Handle file selection
  const handleFile = useCallback((file: File) => {
    setParseError(null);

    const fileName = file.name.toLowerCase();
    const isVCard = fileName.endsWith('.vcf');
    const isCSV = fileName.endsWith('.csv');

    if (!isVCard && !isCSV) {
      setParseError('Please upload a CSV or vCard (.vcf) file');
      return;
    }

    setFileType(isVCard ? 'vcf' : 'csv');

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        setRawFileContent(text);
        
        const rows = parseFileForPreview(text, isVCard);
        
        if (rows.length === 0) {
          setParseError(`No valid contacts found in ${isVCard ? 'vCard' : 'CSV'} file`);
          return;
        }

        setParsedRows(rows);
        setViewState('preview');
      } catch (err) {
        setParseError(err instanceof Error ? err.message : 'Failed to parse file');
      }
    };
    reader.onerror = () => {
      setParseError('Failed to read file');
    };
    reader.readAsText(file);
  }, [parseFileForPreview]);

  // Drag and drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // File input change
  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }, [handleFile]);

  // Remove a row from preview
  const handleRemoveRow = useCallback((index: number) => {
    setParsedRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Start import using the server-side API
  const handleImport = useCallback(async () => {
    const validRows = parsedRows.filter((r) => r.isValid);
    if (validRows.length === 0) return;

    setViewState('importing');
    setImportProgress(50); // Show progress

    try {
      // Use the server-side import API
      const formData = new FormData();
      const blob = new Blob([rawFileContent], { 
        type: fileType === 'vcf' ? 'text/vcard' : 'text/csv' 
      });
      formData.append('file', blob, `import.${fileType}`);

      const result = await uploadFile('/api/import/upload', {
        method: 'POST',
        body: formData,
      });

      setImportProgress(100);
      setImportResult(result);
      setViewState('complete');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Import failed');
      setViewState('preview');
    }
  }, [parsedRows, rawFileContent, fileType, uploadFile]);

  // Reset to start
  const handleReset = useCallback(() => {
    setViewState('upload');
    setParsedRows([]);
    setImportResult(null);
    setImportProgress(0);
    setParseError(null);
    setSelectedCircleId('');
    setFileType(null);
    setRawFileContent('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Count stats
  const validCount = parsedRows.filter((r) => r.isValid).length;
  const invalidCount = parsedRows.filter((r) => !r.isValid).length;

  return (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Import Contacts</h1>
        <p className="text-gray-500">
          Upload a CSV or vCard (.vcf) file to import your contacts in bulk.
        </p>
      </div>

      {/* Upload View */}
      {viewState === 'upload' && (
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`bg-white rounded-xl border-2 border-dashed p-12 text-center transition-colors ${
              isDragging
                ? 'border-bethany-500 bg-bethany-50'
                : 'border-gray-300 hover:border-gray-400'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.vcf"
              onChange={handleFileInputChange}
              className="hidden"
            />
            
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <Upload className="w-8 h-8 text-gray-400" />
            </div>
            
            <h2 className="text-lg font-medium text-gray-900 mb-2">
              Drop your file here
            </h2>
            <p className="text-gray-500 mb-4">
              Supports CSV and vCard (.vcf) files
            </p>
            
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
            >
              Choose File
            </button>

            {parseError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
                <AlertCircle className="w-4 h-4 inline mr-2" />
                {parseError}
              </div>
            )}
          </div>

          {/* Format options */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* CSV Template */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <FileSpreadsheet className="w-5 h-5 text-green-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900 mb-1">CSV Format</h3>
                  <p className="text-sm text-gray-500 mb-3">
                    Standard spreadsheet format with name, phone, email, notes columns.
                  </p>
                  <button
                    onClick={handleDownloadTemplate}
                    className="inline-flex items-center gap-2 text-sm text-bethany-600 hover:text-bethany-700 font-medium"
                  >
                    <Download className="w-4 h-4" />
                    Download template
                  </button>
                </div>
              </div>
            </div>

            {/* vCard info */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Smartphone className="w-5 h-5 text-blue-600" />
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900 mb-1">vCard (.vcf)</h3>
                  <p className="text-sm text-gray-500 mb-3">
                    Export from iPhone: Contacts → Select All → Share → Export vCard
                  </p>
                  <span className="inline-flex items-center gap-1 text-sm text-gray-400">
                    <FileText className="w-4 h-4" />
                    Works with iOS, Android, and Outlook
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Format requirements */}
          <div className="bg-gray-50 rounded-xl p-5">
            <h3 className="font-medium text-gray-900 mb-3">Supported fields</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-500" />
                <span><strong>Name</strong> (required)</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-500" />
                <span>Phone</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-500" />
                <span>Email</span>
              </div>
              <div className="flex items-center gap-2">
                <Check className="w-4 h-4 text-green-500" />
                <span>Notes</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Preview View */}
      {viewState === 'preview' && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="inline-flex items-center gap-2 px-2 py-1 bg-gray-100 rounded text-xs font-medium text-gray-600 uppercase">
                {fileType === 'vcf' ? 'vCard' : 'CSV'}
              </span>
              <span className="text-sm text-gray-600">
                <strong className="text-gray-900">{parsedRows.length}</strong> contacts found
              </span>
              {invalidCount > 0 && (
                <span className="text-sm text-orange-600">
                  <AlertTriangle className="w-4 h-4 inline mr-1" />
                  {invalidCount} with errors
                </span>
              )}
            </div>
            <button
              onClick={handleReset}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Start over
            </button>
          </div>

          {/* Circle selector */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Add all contacts to a circle (optional)
            </label>
            <div className="relative">
              <select
                value={selectedCircleId}
                onChange={(e) => setSelectedCircleId(e.target.value)}
                className="w-full md:w-64 appearance-none px-4 py-2 pr-10 border border-gray-300 rounded-lg bg-white focus:ring-2 focus:ring-bethany-500 focus:border-transparent outline-none"
              >
                <option value="">No circle (sort later)</option>
                {circles?.map((circle) => (
                  <option key={circle.id} value={circle.id}>
                    {circle.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
            </div>
          </div>

          {/* Preview table */}
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Email</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Notes</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {parsedRows.slice(0, 50).map((row, index) => (
                    <tr key={index} className={row.isValid ? '' : 'bg-red-50'}>
                      <td className="px-4 py-3">
                        {row.isValid ? (
                          <CheckCircle2 className="w-4 h-4 text-green-500" />
                        ) : (
                          <span className="flex items-center gap-1 text-red-600">
                            <XCircle className="w-4 h-4" />
                            <span className="text-xs">{row.error}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-medium text-gray-900">{row.name || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.phone || '—'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.email || '—'}</td>
                      <td className="px-4 py-3 text-gray-600 max-w-xs truncate">{row.notes || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRemoveRow(index)}
                          className="p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded"
                          title="Remove row"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {parsedRows.length > 50 && (
              <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 text-sm text-gray-500 text-center">
                Showing first 50 of {parsedRows.length} contacts
              </div>
            )}
          </div>

          {parseError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
              <AlertCircle className="w-4 h-4 inline mr-2" />
              {parseError}
            </div>
          )}

          {/* Import button */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">
                Import {validCount} contact{validCount !== 1 ? 's' : ''}?
              </p>
              {invalidCount > 0 && (
                <p className="text-sm text-gray-500">
                  {invalidCount} contact{invalidCount !== 1 ? 's' : ''} with errors will be skipped
                </p>
              )}
            </div>
            <button
              onClick={handleImport}
              disabled={validCount === 0}
              className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Upload className="w-4 h-4" />
              Import
            </button>
          </div>
        </div>
      )}

      {/* Importing View */}
      {viewState === 'importing' && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="w-16 h-16 bg-bethany-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <Loader2 className="w-8 h-8 text-bethany-500 animate-spin" />
          </div>
          <h2 className="text-lg font-medium text-gray-900 mb-2">Importing contacts...</h2>
          <p className="text-gray-500 mb-6">
            Please don't close this page
          </p>
          
          {/* Progress bar */}
          <div className="max-w-xs mx-auto">
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-bethany-500 transition-all duration-300"
                style={{ width: `${importProgress}%` }}
              />
            </div>
            <p className="text-sm text-gray-500 mt-2">{importProgress}%</p>
          </div>
        </div>
      )}

      {/* Complete View */}
      {viewState === 'complete' && importResult && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-500" />
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-4">Import complete!</h2>
            
            <div className="flex items-center justify-center gap-6 mb-6">
              <div className="text-center">
                <p className="text-2xl font-semibold text-green-600">{importResult.imported}</p>
                <p className="text-sm text-gray-500">Imported</p>
              </div>
              {importResult.duplicatesSkipped > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-yellow-600">{importResult.duplicatesSkipped}</p>
                  <p className="text-sm text-gray-500">Duplicates skipped</p>
                </div>
              )}
              {importResult.invalidRows > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-red-600">{importResult.invalidRows}</p>
                  <p className="text-sm text-gray-500">Invalid</p>
                </div>
              )}
            </div>

            <p className="text-sm text-gray-500 mb-6">
              Imported contacts appear in the <strong>Unsorted</strong> tab. Assign them to circles to see them on your dartboards.
            </p>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={handleReset}
                className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
              >
                Import More
              </button>
              <a
                href="/overview"
                className="px-5 py-2.5 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                Go to Dashboard
              </a>
            </div>
          </div>

          {/* Error details */}
          {importResult.errors && importResult.errors.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h3 className="font-medium text-gray-900">Skipped rows</h3>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-200">
                    {importResult.errors.map((error, index) => (
                      <tr key={index}>
                        <td className="px-4 py-2 text-gray-500">Row {error.row}</td>
                        <td className="px-4 py-2 text-red-600">{error.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Parsing Helpers (for preview only - actual import uses server-side parsing)
// ===========================================================================

/**
 * Parse CSV for preview
 */
function parseCSVForPreview(text: string): ParsedRow[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) {
    throw new Error('CSV must have a header row and at least one data row');
  }

  // Parse header
  const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  
  const hasName = header.includes('name') || header.includes('full name');
  if (!hasName) {
    throw new Error('CSV must have a "name" column');
  }

  const nameIdx = header.findIndex(h => h === 'name' || h === 'full name');
  const phoneIdx = header.findIndex(h => h.includes('phone') || h === 'mobile' || h === 'cell');
  const emailIdx = header.findIndex(h => h.includes('email') || h === 'mail');
  const notesIdx = header.findIndex(h => h.includes('note') || h === 'comments' || h === 'description');

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    
    const rawRow: Record<string, string> = {};
    header.forEach((h, idx) => {
      rawRow[h] = values[idx] || '';
    });

    const name = (values[nameIdx] || '').trim();
    const phone = phoneIdx >= 0 ? (values[phoneIdx] || '').trim() : '';
    const email = emailIdx >= 0 ? (values[emailIdx] || '').trim() : '';
    const notes = notesIdx >= 0 ? (values[notesIdx] || '').trim() : '';

    let isValid = true;
    let error: string | undefined;

    if (!name) {
      isValid = false;
      error = 'Missing name';
    }

    rows.push({ name, phone, email, notes, rawRow, isValid, error });
  }

  return rows;
}

/**
 * Parse vCard for preview
 */
function parseVCardForPreview(text: string): ParsedRow[] {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, ''); // Unfold continued lines

  const vCardBlocks = normalized.split(/(?=BEGIN:VCARD)/i).filter(block => 
    block.trim().toUpperCase().startsWith('BEGIN:VCARD')
  );

  if (vCardBlocks.length === 0) {
    throw new Error('No valid vCard entries found');
  }

  const rows: ParsedRow[] = [];

  for (const block of vCardBlocks) {
    const lines = block.split('\n');
    
    let name = '';
    let phone = '';
    let email = '';
    let notes = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'BEGIN:VCARD' || trimmed === 'END:VCARD') continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const propertyPart = trimmed.substring(0, colonIndex).toUpperCase();
      let value = trimmed.substring(colonIndex + 1);
      const propertyName = propertyPart.split(';')[0];

      // Decode QUOTED-PRINTABLE
      if (propertyPart.includes('ENCODING=QUOTED-PRINTABLE')) {
        value = value.replace(/=\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => 
          String.fromCharCode(parseInt(hex, 16))
        );
      }

      switch (propertyName) {
        case 'FN':
          name = value.trim();
          break;
        case 'N':
          if (!name) {
            const parts = value.split(';').map(p => p.trim()).filter(Boolean);
            if (parts.length >= 2) {
              name = `${parts[1]} ${parts[0]}`.trim();
            } else if (parts.length === 1) {
              name = parts[0];
            }
          }
          break;
        case 'TEL':
          if (!phone) phone = value.trim();
          break;
        case 'EMAIL':
          if (!email) email = value.trim();
          break;
        case 'NOTE':
          notes = value.trim();
          break;
        case 'ORG':
          if (value.trim()) {
            notes = notes ? `${notes}; Company: ${value.trim()}` : `Company: ${value.trim()}`;
          }
          break;
      }
    }

    const isValid = !!name;
    const error = isValid ? undefined : 'Missing name';

    rows.push({
      name,
      phone,
      email,
      notes,
      rawRow: { name, phone, email, notes },
      isValid,
      error,
    });
  }

  return rows;
}

/**
 * Parse a single CSV line, handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  
  values.push(current.trim());
  return values;
}

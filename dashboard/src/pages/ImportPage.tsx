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

interface ImportResult {
  status: 'success' | 'skipped' | 'error';
  name: string;
  error?: string;
}

type ViewState = 'upload' | 'preview' | 'importing' | 'complete';

// ===========================================================================
// CSV Template
// ===========================================================================

const CSV_TEMPLATE = `name,phone,email,notes
John Smith,+15551234567,john@example.com,Met at conference
Jane Doe,+15559876543,jane@example.com,College friend
Bob Wilson,,bob@company.com,Work colleague`;

const REQUIRED_COLUMNS = ['name'];
const OPTIONAL_COLUMNS = ['phone', 'email', 'notes'];

const ACCEPTED_FILE_TYPES = '.csv,.vcf,.vcard';

// ===========================================================================
// Component
// ===========================================================================

export function ImportPage() {
  const [viewState, setViewState] = useState<ViewState>('upload');
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [selectedCircleId, setSelectedCircleId] = useState<string>('');
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [importProgress, setImportProgress] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileType, setFileType] = useState<'csv' | 'vcf' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: circles } = useApi<Circle[]>('/api/circles');
  const { execute: createContact } = useLazyApi();

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

  // Parse CSV file
  const parseCSV = useCallback((text: string): ParsedRow[] => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) {
      throw new Error('CSV must have a header row and at least one data row');
    }

    // Parse header
    const header = lines[0].toLowerCase().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    
    // Check for required columns
    const hasName = header.includes('name');
    if (!hasName) {
      throw new Error('CSV must have a "name" column');
    }

    // Map column indices
    const nameIdx = header.indexOf('name');
    const phoneIdx = header.indexOf('phone');
    const emailIdx = header.indexOf('email');
    const notesIdx = header.indexOf('notes');

    // Parse data rows
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

      // Validate
      let isValid = true;
      let error: string | undefined;

      if (!name) {
        isValid = false;
        error = 'Name is required';
      } else if (email && !isValidEmail(email)) {
        isValid = false;
        error = 'Invalid email format';
      } else if (phone && !isValidPhone(phone)) {
        isValid = false;
        error = 'Invalid phone format';
      }

      rows.push({ name, phone, email, notes, rawRow, isValid, error });
    }

    return rows;
  }, []);

  // Parse vCard file
  const parseVCard = useCallback((text: string): ParsedRow[] => {
    const rows: ParsedRow[] = [];

    // Unfold continuation lines
    const unfolded = text.replace(/\r?\n[ \t]/g, '');

    // Split into individual vCard blocks
    const blocks = unfolded.split(/(?=BEGIN:VCARD)/i);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed.toUpperCase().startsWith('BEGIN:VCARD')) continue;

      const lines = trimmed.split(/\r?\n/);

      let name = '';
      let phone = '';
      let email = '';
      let notes = '';
      let structuredName = '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.toUpperCase() === 'BEGIN:VCARD' || line.toUpperCase() === 'END:VCARD') continue;
        if (line.toUpperCase().startsWith('VERSION:')) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const propertyPart = line.substring(0, colonIdx);
        let value = line.substring(colonIdx + 1).trim();

        const semiIdx = propertyPart.indexOf(';');
        const propName = (semiIdx >= 0 ? propertyPart.substring(0, semiIdx) : propertyPart).toUpperCase();
        const params = semiIdx >= 0 ? propertyPart.substring(semiIdx + 1).toUpperCase() : '';

        // Decode QUOTED-PRINTABLE
        if (params.includes('ENCODING=QUOTED-PRINTABLE')) {
          value = decodeQuotedPrintable(value);
        }

        // Unescape vCard special chars
        value = value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

        switch (propName) {
          case 'FN':
            name = value.trim();
            break;
          case 'N': {
            const parts = value.split(';');
            const lastName = (parts[0] || '').trim();
            const firstName = (parts[1] || '').trim();
            const middleName = (parts[2] || '').trim();
            structuredName = [firstName, middleName, lastName].filter(Boolean).join(' ');
            break;
          }
          case 'TEL':
            if (!phone || params.includes('CELL') || params.includes('MOBILE') || params.includes('IPHONE')) {
              phone = value.trim();
            }
            break;
          case 'EMAIL':
            if (!email) {
              email = value.trim();
            }
            break;
          case 'NOTE':
            notes = value.trim();
            break;
        }
      }

      // Fallback to structured name
      if (!name && structuredName) {
        name = structuredName;
      }

      // Validate
      let isValid = true;
      let error: string | undefined;

      if (!name) {
        isValid = false;
        error = 'No name found in vCard';
      } else if (email && !isValidEmail(email)) {
        isValid = false;
        error = 'Invalid email format';
      }

      const rawRow: Record<string, string> = { name, phone, email, notes };

      rows.push({ name: name || '(unnamed)', phone, email, notes, rawRow, isValid, error });
    }

    if (rows.length === 0) {
      throw new Error('No vCard entries found. Make sure the file contains BEGIN:VCARD blocks.');
    }

    return rows;
  }, []);

  // Handle file selection
  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setFileType(null);

    const fileName = file.name.toLowerCase();
    const isVcf = fileName.endsWith('.vcf') || fileName.endsWith('.vcard');
    const isCsv = fileName.endsWith('.csv');

    if (!isVcf && !isCsv) {
      setParseError('Please upload a CSV or vCard (.vcf) file');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;

        // Auto-detect: even if extension is .csv, check if it's actually a vCard
        const looksLikeVCard = text.trim().startsWith('BEGIN:VCARD');

        let rows: ParsedRow[];
        if (isVcf || looksLikeVCard) {
          rows = parseVCard(text);
          setFileType('vcf');
        } else {
          rows = parseCSV(text);
          setFileType('csv');
        }
        
        if (rows.length === 0) {
          setParseError('No valid contacts found in file');
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
  }, [parseCSV, parseVCard]);

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

  // Start import
  const handleImport = useCallback(async () => {
    const validRows = parsedRows.filter((r) => r.isValid);
    if (validRows.length === 0) return;

    setViewState('importing');
    setImportProgress(0);
    const results: ImportResult[] = [];

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      
      try {
        await createContact('/api/contacts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: row.name,
            phone: row.phone || undefined,
            email: row.email || undefined,
            notes: row.notes || undefined,
            circle_ids: selectedCircleId ? [selectedCircleId] : undefined,
            source: 'import',
          }),
        });

        results.push({ status: 'success', name: row.name });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error';
        
        // Check for duplicate
        if (errorMsg.includes('duplicate') || errorMsg.includes('already exists')) {
          results.push({ status: 'skipped', name: row.name, error: 'Already exists' });
        } else {
          results.push({ status: 'error', name: row.name, error: errorMsg });
        }
      }

      setImportProgress(Math.round(((i + 1) / validRows.length) * 100));
    }

    setImportResults(results);
    setViewState('complete');
  }, [parsedRows, selectedCircleId, createContact]);

  // Reset to start
  const handleReset = useCallback(() => {
    setViewState('upload');
    setParsedRows([]);
    setImportResults([]);
    setImportProgress(0);
    setParseError(null);
    setSelectedCircleId('');
    setFileType(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // Count stats
  const validCount = parsedRows.filter((r) => r.isValid).length;
  const invalidCount = parsedRows.filter((r) => !r.isValid).length;
  const successCount = importResults.filter((r) => r.status === 'success').length;
  const skippedCount = importResults.filter((r) => r.status === 'skipped').length;
  const errorCount = importResults.filter((r) => r.status === 'error').length;

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
              accept={ACCEPTED_FILE_TYPES}
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

          {/* iPhone vCard tip */}
          <div className="bg-blue-50 rounded-xl p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                <Smartphone className="w-5 h-5 text-blue-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-gray-900 mb-1">Importing from iPhone?</h3>
                <p className="text-sm text-gray-600">
                  Open Contacts, select the contacts you want, tap Share, then choose "Export vCard".
                  Upload the .vcf file here and Bethany will handle the rest.
                </p>
              </div>
            </div>
          </div>

          {/* Template download */}
          <div className="bg-gray-50 rounded-xl p-6">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                <FileSpreadsheet className="w-5 h-5 text-gray-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-medium text-gray-900 mb-1">Prefer a spreadsheet?</h3>
                <p className="text-sm text-gray-500 mb-3">
                  Download our CSV template with the correct columns: name, phone, email, and notes.
                </p>
                <button
                  onClick={handleDownloadTemplate}
                  className="inline-flex items-center gap-2 text-sm text-bethany-600 hover:text-bethany-700 font-medium"
                >
                  <Download className="w-4 h-4" />
                  Download CSV template
                </button>
              </div>
            </div>
          </div>

          {/* Format requirements */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="font-medium text-gray-900 mb-3">Supported formats</h3>
            <ul className="text-sm text-gray-600 space-y-2">
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                <span><strong>vCard (.vcf)</strong> — Exported from iPhone, Android, Google Contacts, or Outlook</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                <span><strong>CSV</strong> — Spreadsheet with <strong>name</strong> column (required), plus optional phone, email, notes</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                <span>Multi-contact files are supported (batch import)</span>
              </li>
              <li className="flex items-start gap-2">
                <Check className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                <span>Phone numbers should include country code (e.g., +1 for US)</span>
              </li>
            </ul>
          </div>
        </div>
      )}

      {/* Preview View */}
      {viewState === 'preview' && (
        <div className="space-y-4">
          {/* Summary bar */}
          <div className="bg-white rounded-xl border border-gray-200 p-4 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">
                <strong className="text-gray-900">{parsedRows.length}</strong> contact{parsedRows.length !== 1 ? 's' : ''} found
                {fileType && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    {fileType === 'vcf' ? 'vCard' : 'CSV'}
                  </span>
                )}
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
                <option value="">No circle</option>
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
                      <td className="px-4 py-3 font-medium text-gray-900">{row.name || '\u2014'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.phone || '\u2014'}</td>
                      <td className="px-4 py-3 text-gray-600">{row.email || '\u2014'}</td>
                      <td className="px-4 py-3 text-gray-600 max-w-xs truncate">{row.notes || '\u2014'}</td>
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
      {viewState === 'complete' && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-center">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-green-500" />
            </div>
            <h2 className="text-lg font-medium text-gray-900 mb-4">Import complete!</h2>
            
            <div className="flex items-center justify-center gap-6 mb-6">
              <div className="text-center">
                <p className="text-2xl font-semibold text-green-600">{successCount}</p>
                <p className="text-sm text-gray-500">Imported</p>
              </div>
              {skippedCount > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-yellow-600">{skippedCount}</p>
                  <p className="text-sm text-gray-500">Skipped</p>
                </div>
              )}
              {errorCount > 0 && (
                <div className="text-center">
                  <p className="text-2xl font-semibold text-red-600">{errorCount}</p>
                  <p className="text-sm text-gray-500">Failed</p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-center gap-3">
              <button
                onClick={handleReset}
                className="px-5 py-2.5 bg-bethany-500 text-white font-medium rounded-lg hover:bg-bethany-600 transition-colors"
              >
                Import More
              </button>
              <a
                href="/contacts"
                className="px-5 py-2.5 border border-gray-300 text-gray-700 font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                View Contacts
              </a>
            </div>
          </div>

          {/* Results detail */}
          {(skippedCount > 0 || errorCount > 0) && (
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200">
                <h3 className="font-medium text-gray-900">Import details</h3>
              </div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-gray-200">
                    {importResults.map((result, index) => (
                      <tr key={index}>
                        <td className="px-4 py-2">
                          {result.status === 'success' && (
                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                          )}
                          {result.status === 'skipped' && (
                            <AlertTriangle className="w-4 h-4 text-yellow-500" />
                          )}
                          {result.status === 'error' && (
                            <XCircle className="w-4 h-4 text-red-500" />
                          )}
                        </td>
                        <td className="px-4 py-2 font-medium text-gray-900">{result.name}</td>
                        <td className="px-4 py-2 text-gray-500">
                          {result.status === 'success' && 'Imported'}
                          {result.status === 'skipped' && result.error}
                          {result.status === 'error' && result.error}
                        </td>
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
// Helpers
// ===========================================================================

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
        // Escaped quote
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

/**
 * Decode QUOTED-PRINTABLE encoded string.
 */
function decodeQuotedPrintable(input: string): string {
  let result = input.replace(/=\r?\n/g, '');
  result = result.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return result;
}

/**
 * Basic email validation
 */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Basic phone validation (allows various formats)
 */
function isValidPhone(phone: string): boolean {
  // Allow digits, spaces, dashes, parens, and + sign
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  return /^\+?\d{7,15}$/.test(cleaned);
}

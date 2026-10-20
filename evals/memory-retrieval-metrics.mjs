/** Failed labeled cases remain in the denominator; infrastructure failures are separate. */
export function summarizeRetrieval(rows) {
  const measured = rows.filter(row => !row.infrastructureFailure);
  const cases = measured.filter(row => row.retrievalRecall != null);
  const mean = key => {
    const values = cases.filter(row => Number.isFinite(row[key]));
    return { n: values.length, value: values.length ? values.reduce((sum, row) => sum + row[key], 0) / values.length : null };
  };
  return {
    candidateRecall: mean('retrievalRecall'), injectionRecall: mean('injectionRecall'),
    precisionAtK: mean('precisionAtK'),
    failures: measured.filter(row => !row.passed).length,
    failureRate: measured.length ? measured.filter(row => !row.passed).length / measured.length : null,
    infrastructureFailures: rows.length - measured.length,
    note: 'Synthetic labeled evidence only. Precision@K = relevant injected entries among the first K / configured K (unfilled slots score zero); extraction and final-answer quality are unmeasured.',
  };
}

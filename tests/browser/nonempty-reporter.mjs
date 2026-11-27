// Playwright already rejects unmatched grep filters. Also reject a selected
// suite whose scenarios were all skipped, without retaining successful runs.
export default class NonemptyBrowserReporter {
 passed=0;
 onTestEnd(_test,result) {
  if(result.status==='passed')this.passed++;
 }
 onEnd(result) {
  if(result.status==='passed'&&!this.passed){
   console.error('No actual browser scenarios passed (empty or entirely skipped scope).');
   return {status:'failed'};
  }
 }
}

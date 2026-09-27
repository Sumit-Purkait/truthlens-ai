// Test runner for Phase 4.1 requirements
const claims = [
  { type: "factual", claim: "The Great Wall of China is visible from the Moon with the naked eye" },
  { type: "political_government", claim: "Sumit Purkait is PM of India" },
  { type: "scientific", claim: "NASA James Webb Space Telescope discovered an atmosphere on TRAPPIST-1e" }
];

const ALLOWED_TYPES = new Set([
  'Official Government Source',
  'Primary Source',
  'Reputable News Source',
  'Public Reference',
  'Verified Web Resource',
  'Submitted Page'
]);

async function runTests() {
  console.log("=== STARTING TRUTHLENS PHASE 4.1 VERIFICATION TESTS ===\n");
  
  for (const { type, claim } of claims) {
    console.log(`--------------------------------------------------`);
    console.log(`TEST [${type.toUpperCase()}]: "${claim}"`);
    console.log(`--------------------------------------------------`);
    
    try {
      const startTime = Date.now();
      const res = await fetch("http://localhost:5000/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim })
      });
      
      const latency = Date.now() - startTime;
      const data = await res.json();
      
      console.log(`Status: ${res.status} (${latency}ms)`);
      console.log(`Verdict: ${data.verdict} (Confidence: ${data.confidence}%)`);
      console.log(`Verification Mode: ${data.verificationMode}`);
      console.log(`Engine: ${data.engine}`);
      if (data.warning) console.log(`Warning/Notice: ${data.warning}`);
      console.log(`Explanation: ${data.explanation?.slice(0, 180)}...`);
      console.log(`Evidence: ${data.evidence?.slice(0, 150)}...`);
      console.log(`Total Sources: ${data.sources?.length || 0}`);
      
      // Validation checks
      let passed = true;
      if ((data.sources?.length || 0) > 5) {
        console.error(`FAIL: More than 5 sources returned (${data.sources.length})`);
        passed = false;
      }
      
      for (const [idx, s] of (data.sources || []).entries()) {
        const typeValid = ALLOWED_TYPES.has(s.type);
        console.log(`  Source [${idx + 1}]: "${s.title}"`);
        console.log(`     Publisher: ${s.publisher} | Domain: ${s.domain} | Type: [${s.type}] ${typeValid ? '✓' : '✗ INVALID TYPE'}`);
        console.log(`     URL: ${s.url}`);
        if (!typeValid) {
          console.error(`FAIL: Invalid source type: ${s.type}`);
          passed = false;
        }
      }
      
      console.log(`\nTest Result: ${passed ? '✓ PASSED' : '✗ FAILED'}\n`);
    } catch (err) {
      console.error(`Error during test:`, err.message);
    }
  }
}

runTests();

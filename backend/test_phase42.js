// Comprehensive Verification Test Suite for Phase 4.2 Requirements
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

const FORBIDDEN_WORDS = [
  /corroborat/i,
  /verified\s+across/i,
  /verified\s+against/i,
  /cross-examin/i
];

async function runTests() {
  console.log("=== STARTING FACTSIFT AI PHASE 4.2 VERIFICATION TESTS ===\n");
  let allPassed = true;
  
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
      console.log(`Evidence: "${data.evidence}"`);
      console.log(`Total Sources: ${data.sources?.length || 0}`);
      
      let passed = true;
      
      // Requirement 1 Check: No forbidden wording in fallback mode
      if (data.verificationMode === "knowledge_fallback") {
        const fullText = `${data.explanation || ""} ${data.evidence || ""}`;
        for (const pattern of FORBIDDEN_WORDS) {
          if (pattern.test(fullText)) {
            console.error(`FAIL: Found forbidden wording matching ${pattern} in fallback result!`);
            passed = false;
          }
        }
        if (data.evidence && !/Referenced from \d+ offline knowledge record/i.test(data.evidence) && data.sources?.length > 0) {
          console.warn(`NOTICE: Evidence did not match standard "Referenced from N offline knowledge records" template.`);
        }
      }

      // Requirement 7 Check: Maximum 5 sources
      if ((data.sources?.length || 0) > 5) {
        console.error(`FAIL: More than 5 sources returned (${data.sources.length})`);
        passed = false;
      }
      
      // Requirement 3 & 4 Check: No duplicate sources from same domain
      const seenDomains = new Set();
      for (const [idx, s] of (data.sources || []).entries()) {
        const d = (s.domain || "").toLowerCase().replace(/^www\./, "");
        if (seenDomains.has(d)) {
          console.error(`FAIL: Duplicate domain detected: ${d}`);
          passed = false;
        }
        seenDomains.add(d);

        // Requirement 6 Check: Valid type
        const typeValid = ALLOWED_TYPES.has(s.type);
        console.log(`  Source [${idx + 1}]: "${s.title}"`);
        console.log(`     Publisher: ${s.publisher} | Domain: ${s.domain} | Type: [${s.type}] ${typeValid ? '✓' : '✗ INVALID TYPE'}`);
        console.log(`     URL: ${s.url}`);
        if (!typeValid) {
          console.error(`FAIL: Invalid source type: ${s.type}`);
          passed = false;
        }
      }
      
      if (!passed) allPassed = false;
      console.log(`\nTest Result: ${passed ? '✓ PASSED' : '✗ FAILED'}\n`);
    } catch (err) {
      console.error(`Error during test:`, err.message);
      allPassed = false;
    }
  }

  console.log(`==================================================`);
  console.log(`OVERALL TEST STATUS: ${allPassed ? 'ALL TESTS PASSED ✓' : 'SOME TESTS FAILED ✗'}`);
  console.log(`==================================================\n`);
}

runTests();

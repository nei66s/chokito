// Tests for Coordinator task decomposition and skill detection
import { TaskDecomposer } from '../src/coordinator/tasks.js';
const decomposer = new TaskDecomposer();
/**
 * Test: Skill Detection
 */
function testSkillDetection() {
    console.log('\n📋 Testing Skill Detection...\n');
    const testCases = [
        {
            input: 'Optimize this TypeScript code for performance',
            expectedSkills: ['typescript', 'performance'],
        },
        {
            input: 'Check security vulnerabilities in this JavaScript app',
            expectedSkills: ['javascript', 'security'],
        },
        {
            input: 'Create API documentation with Swagger',
            expectedSkills: ['api', 'documentation'],
        },
        {
            input: 'Refactor and simplify the database queries',
            expectedSkills: ['database', 'refactoring'],
        },
        {
            input: 'Write unit tests with Jest for this module',
            expectedSkills: ['testing', 'javascript'],
        },
    ];
    let passed = 0;
    let failed = 0;
    for (const testCase of testCases) {
        const detected = decomposer.detectSkills(testCase.input);
        const foundAll = testCase.expectedSkills.every(skill => detected.includes(skill));
        if (foundAll) {
            console.log(`✅ PASS: "${testCase.input.substring(0, 50)}..."`);
            console.log(`   Found: ${detected.join(', ')}`);
            passed++;
        }
        else {
            console.log(`❌ FAIL: "${testCase.input.substring(0, 50)}..."`);
            console.log(`   Expected: ${testCase.expectedSkills.join(', ')}`);
            console.log(`   Got: ${detected.join(', ')}`);
            failed++;
        }
        console.log();
    }
    return { passed, failed };
}
/**
 * Test: Skill to Specialty Mapping
 */
function testSkillMapping() {
    console.log('\n🎯 Testing Skill-to-Specialty Mapping...\n');
    const testCases = [
        {
            skills: ['typescript', 'javascript'],
            expectedSpecialties: ['code-expert'],
        },
        {
            skills: ['security', 'encryption'],
            expectedSpecialties: ['security-specialist'],
        },
        {
            skills: ['performance', 'benchmark'],
            expectedSpecialties: ['performance-optimizer'],
        },
        {
            skills: ['database', 'sql'],
            expectedSpecialties: ['data-analyst'],
        },
        {
            skills: ['documentation', 'api'],
            expectedSpecialties: ['documentation-writer', 'code-expert'],
        },
    ];
    let passed = 0;
    let failed = 0;
    for (const testCase of testCases) {
        const mapped = decomposer.mapSkillsToSpecialties(testCase.skills);
        const foundAll = testCase.expectedSpecialties.every(specialty => mapped.includes(specialty));
        if (foundAll) {
            console.log(`✅ PASS: Skills [${testCase.skills.join(', ')}]`);
            console.log(`   Mapped to: ${mapped.join(', ')}`);
            passed++;
        }
        else {
            console.log(`❌ FAIL: Skills [${testCase.skills.join(', ')}]`);
            console.log(`   Expected: ${testCase.expectedSpecialties.join(', ')}`);
            console.log(`   Got: ${mapped.join(', ')}`);
            failed++;
        }
        console.log();
    }
    return { passed, failed };
}
/**
 * Test: Task Decomposition
 */
async function testTaskDecomposition() {
    console.log('\n🔄 Testing Task Decomposition...\n');
    const testCases = [
        'Implement a secure authentication module in TypeScript',
        'Optimize the database query performance',
        'Document the REST API with examples',
    ];
    let passed = 0;
    for (const testCase of testCases) {
        try {
            const subtasks = await decomposer.decompose(testCase);
            console.log(`✅ Decomposed: "${testCase.substring(0, 50)}..."`);
            console.log(`   Subtasks (${subtasks.length}):`);
            subtasks.forEach((task, idx) => {
                console.log(`     ${idx + 1}. ${task.substring(0, 60)}${task.length > 60 ? '...' : ''}`);
            });
            passed++;
        }
        catch (error) {
            console.log(`❌ Failed to decompose: "${testCase}"`);
            console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`);
        }
        console.log();
    }
    return { passed, failed: testCases.length - passed };
}
/**
 * Run all tests
 */
export async function runAllTests() {
    console.log('=' * 60);
    console.log('COORDINATOR TESTS - Skill Detection & Decomposition');
    console.log('=' * 60);
    const results = [];
    // Test 1: Skill Detection
    const skillDetectionResult = testSkillDetection();
    results.push({ name: 'Skill Detection', ...skillDetectionResult });
    // Test 2: Skill Mapping
    const skillMappingResult = testSkillMapping();
    results.push({ name: 'Skill Mapping', ...skillMappingResult });
    // Test 3: Task Decomposition
    const decompositionResult = await testTaskDecomposition();
    results.push({ name: 'Task Decomposition', ...decompositionResult });
    // Summary
    console.log('\n' + '=' * 60);
    console.log('TEST SUMMARY');
    console.log('=' * 60);
    let totalPassed = 0;
    let totalFailed = 0;
    for (const result of results) {
        const total = result.passed + result.failed;
        const percentage = ((result.passed / total) * 100).toFixed(0);
        console.log(`${result.name}: ${result.passed}/${total} passed (${percentage}%)`);
        totalPassed += result.passed;
        totalFailed += result.failed;
    }
    const grandTotal = totalPassed + totalFailed;
    const overallPercentage = ((totalPassed / grandTotal) * 100).toFixed(0);
    console.log(`\nOVERALL: ${totalPassed}/${grandTotal} passed (${overallPercentage}%)`);
    console.log('=' * 60 + '\n');
    return { totalPassed, totalFailed };
}
// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
    runAllTests().catch(console.error);
}

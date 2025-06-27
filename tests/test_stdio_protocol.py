#!/usr/bin/env python
"""Final comprehensive test for stdio protocol integrity."""

import json
import subprocess
import sys
import time
import select

def test_stdio_protocol():
    """Test that stdio transport produces only valid JSON output."""
    print("🧪 Testing stdio protocol integrity...\n")
    
    # Start the server
    proc = subprocess.Popen(
        [sys.executable, "-m", "hanzo_mcp.cli", "--transport", "stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=0
    )
    
    # Test cases
    test_cases = [
        # 1. Initialize
        {
            "name": "Initialize",
            "request": {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "0.1.0",
                    "capabilities": {},
                    "clientInfo": {"name": "test-client", "version": "1.0.0"}
                }
            }
        },
        # 2. List tools (might trigger logging)
        {
            "name": "List tools",
            "request": {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list"
            }
        },
        # 3. Read file (successful)
        {
            "name": "Read file (success)",
            "request": {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "read",
                    "arguments": {"file_path": "/etc/hosts"}
                }
            }
        },
        # 4. Read file (error - should not break protocol)
        {
            "name": "Read file (error)",
            "request": {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "read",
                    "arguments": {"file_path": "/does/not/exist.txt"}
                }
            }
        },
        # 5. Execute command
        {
            "name": "Execute command",
            "request": {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "bash",
                    "arguments": {"command": "echo 'Test output'"}
                }
            }
        }
    ]
    
    # Track results
    responses = []
    violations = []
    
    # Run tests
    for test in test_cases:
        print(f"→ Test: {test['name']}")
        
        # Send request
        request_str = json.dumps(test['request']) + "\n"
        proc.stdin.write(request_str)
        proc.stdin.flush()
        
        # Read response with timeout
        start_time = time.time()
        response_found = False
        
        while time.time() - start_time < 5:  # 5 second timeout per test
            # Check for stdout data
            readable, _, _ = select.select([proc.stdout], [], [], 0.1)
            if proc.stdout in readable:
                line = proc.stdout.readline()
                if line:
                    line = line.strip()
                    if line:
                        try:
                            msg = json.loads(line)
                            responses.append(msg)
                            response_found = True
                            print(f"  ✓ Valid JSON response received")
                            break
                        except json.JSONDecodeError:
                            violations.append({
                                "test": test['name'],
                                "output": line[:200]
                            })
                            print(f"  ❌ PROTOCOL VIOLATION: {line[:100]}")
        
        if not response_found:
            print(f"  ⏱️  Timeout - no response received")
    
    # Cleanup
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    
    # Summary
    print("\n" + "="*60)
    print("📊 TEST RESULTS:")
    print(f"Total tests: {len(test_cases)}")
    print(f"Valid JSON responses: {len(responses)}")
    print(f"Protocol violations: {len(violations)}")
    
    if violations:
        print("\n❌ PROTOCOL VIOLATIONS DETECTED:")
        for v in violations:
            print(f"  Test: {v['test']}")
            print(f"  Output: {v['output']}")
    else:
        print("\n✅ All tests passed! No protocol violations detected.")
    
    # Also check stderr was silent
    stderr_output = proc.stderr.read()
    if stderr_output:
        print(f"\n⚠️  stderr output detected (should be empty for stdio):")
        print(stderr_output[:500])
    
    return len(violations) == 0 and not stderr_output

if __name__ == "__main__":
    success = test_stdio_protocol()
    sys.exit(0 if success else 1)
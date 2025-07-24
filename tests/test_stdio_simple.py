#!/usr/bin/env python
"""Simple test to check if stdio mode starts without logging interference."""

import json
import subprocess
import sys
import time

# Start the server
proc = subprocess.Popen(
    [sys.executable, "-m", "hanzo_mcp.cli", "--transport", "stdio"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=0
)

# Send initialize request
request = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "0.1.0",
        "capabilities": {},
        "clientInfo": {"name": "test-client", "version": "1.0.0"}
    }
}

print("Sending initialize request...")
proc.stdin.write(json.dumps(request) + "\n")
proc.stdin.flush()

# Read response for 5 seconds
start_time = time.time()
output_lines = []
error_lines = []

while time.time() - start_time < 5:
    # Check stdout
    import select
    readable, _, _ = select.select([proc.stdout], [], [], 0.1)
    if proc.stdout in readable:
        line = proc.stdout.readline()
        if line:
            output_lines.append(line.strip())
            try:
                msg = json.loads(line)
                print(f"✓ Valid JSON response: {msg.get('method', msg.get('result', 'response')[:50] if isinstance(msg.get('result'), str) else 'response')}")
            except json.JSONDecodeError:
                print(f"❌ PROTOCOL VIOLATION - Non-JSON output: {line.strip()[:100]}")
    
    # Check stderr
    readable, _, _ = select.select([proc.stderr], [], [], 0.1)
    if proc.stderr in readable:
        line = proc.stderr.readline()
        if line:
            error_lines.append(line.strip())
            print(f"[STDERR] {line.strip()}")

# Terminate
proc.terminate()
try:
    proc.wait(timeout=2)
except subprocess.TimeoutExpired:
    proc.kill()
    proc.wait()

# Summary
print("\n" + "="*60)
print("SUMMARY:")
print(f"Total stdout lines: {len(output_lines)}")
print(f"Total stderr lines: {len(error_lines)}")

# Check for any non-JSON stdout
violations = 0
for line in output_lines:
    if line:
        try:
            json.loads(line)
        except json.JSONDecodeError:
            violations += 1
            print(f"Non-JSON line: {line[:100]}")

if violations == 0 and output_lines:
    print("✅ All stdout output is valid JSON!")
else:
    print(f"❌ Found {violations} protocol violations")

if __name__ == "__main__":
    sys.exit(0 if violations == 0 else 1)
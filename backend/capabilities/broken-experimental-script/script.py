import json
import sys
import time

mode = json.load(sys.stdin)["mode"]
print(f"Starting isolation experiment: {mode}", file=sys.stderr, flush=True)
if mode == "crash":
    1 / 0
elif mode == "timeout":
    while True:
        time.sleep(1)
elif mode == "syntax_error":
    exec("def intentionally_broken(:")
elif mode == "missing_dependency":
    import capability_dependency_that_does_not_exist
elif mode == "invalid_json":
    print("this is not JSON")
elif mode == "noisy":
    while True:
        print("log flood " * 1000, flush=True)
else:
    print(json.dumps({"message": "The capability completed. Other capabilities remain independent.", "crash_widget": mode == "ui_crash"}))

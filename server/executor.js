import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_CODE_BYTES = 100 * 1024;
const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

async function runContainer(containerName, dockerArguments) {
  let timedOut = false;

  // Explicitly kill the container after five seconds.
  const killTimer = setTimeout(() => {
    timedOut = true;

    execFile(
      "docker",
      ["kill", containerName],
      {
        timeout: 3000,
      },
      () => {}
    );
  }, TIMEOUT_MS);

  try {
    const { stdout, stderr } = await execFileAsync(
      "docker",
      dockerArguments,
      {
        // Backup timeout in case the Docker command itself becomes stuck.
        timeout: TIMEOUT_MS + 5000,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      }
    );

    return {
      stdout,
      stderr,
      exitCode: 0,
    };
  } catch (error) {
    const executionTimedOut =
      timedOut || error.killed || error.signal === "SIGTERM";

    return {
      stdout: error.stdout || "",
      stderr: executionTimedOut
        ? `${error.stderr || ""}\nExecution timed out`.trim()
        : error.stderr || error.message,
      exitCode: executionTimedOut
        ? 124
        : typeof error.code === "number"
          ? error.code
          : 1,
    };
  } finally {
    clearTimeout(killTimer);

    await execFileAsync(
      "docker",
      ["rm", "-f", containerName],
      {
        timeout: 3000,
      }
    ).catch(() => {});
  }
}

export async function executeCode({ language, code }) {
  if (!["python", "c"].includes(language)) {
    throw new Error("Unsupported language");
  }

  if (typeof code !== "string") {
    throw new Error("Code must be a string");
  }
  if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
    throw new Error("Code exceeds the 100 KB limit");
}   
  const directory = await mkdtemp(join(tmpdir(), "ccd-execution-"));
  const containerName = `ccd-execution-${randomUUID()}`;

  try {
    // mkdtemp creates a private directory. The container user needs
    // permission to enter it and read the source file.
    await chmod(directory, 0o755);

    const filename = language === "python" ? "main.py" : "main.c";
    await writeFile(join(directory, filename), code, {
      encoding: "utf8",
      mode: 0o644,
    });

    const commonArguments = [
      "run",
      "--rm",
      "--name",
      containerName,

      "--network",
      "none",

      "--memory",
      "128m",

      "--memory-swap",
      "128m",

      "--cpus",
      "0.5",

      "--pids-limit",
      "64",

      "--read-only",

      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=64m",

      "--cap-drop",
      "ALL",

      "--security-opt",
      "no-new-privileges",

      "--user",
      "65534:65534",

      "--env",
      "HOME=/tmp",

      "--mount",
      `type=bind,source=${directory},target=/workspace,readonly`,
    ];

    if (language === "python") {
      return await runContainer(containerName, [
        ...commonArguments,
        "python:3.13-alpine",
        "python",
        "-I",
        "-B",
        "/workspace/main.py",
      ]);
    }

    return await runContainer(containerName, [
      ...commonArguments,
      "gcc:14",
      "sh",
      "-c",
      "gcc -std=c17 -Wall -Wextra /workspace/main.c -o /tmp/program && /tmp/program",
    ]);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
}
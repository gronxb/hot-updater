/**
 * Writes a sandbox build's HotUpdaterImpl from the source this build packages,
 * so a patch of the SDK stays in it. A line of the source's structure that moved
 * means an SDK this generator doesn't know: it stops, and never compiles the
 * original. Comments and blank lines don't count, line endings don't either.
 */
class HotUpdaterSandboxImplGenerator {
  static final String HEADER = "// Generated for a sandbox build. Do not edit.\n"

  static final String CLASS_LINE = "class HotUpdaterImpl {"

  /** What the getter does before its launch accounting. Nothing else may run first. */
  static final List<String> GETTER_PRELUDE = [
    "if (HotUpdaterProcess.isRestartProcess(context)) {",
    "return bundleStorage.getFallbackBundleURL()",
    "}",
  ]
  static final String GETTER = "    fun getJSBundleFile(): String {"
  static final String GETTER_ANCHOR = "val bundleUrl = prepareLaunchIfNeeded().bundleUrl"
  static final String GETTER_LINE = "        if (environment.isMain) HotUpdaterSandboxDev.bundleOfThisProcess(context)?.let { return it }"

  static final String RESTART = "    private fun restartApplication(reactContext: Context): Boolean {"
  static final String RESTART_ANCHOR = "val applicationContext = reactContext.applicationContext"
  static final String RESTART_LINE = "        if (environment.isMain && HotUpdaterSandboxDev.relaunch(reactContext)) return true"

  /** The constructor's assignments, each replaced by the dev session's view when this process runs one. */
  static final Map<String, String> ASSIGNMENTS = [
    "        this.bundleStorage = bundleStorage":
      "        this.bundleStorage = HotUpdaterSandboxDev.storage(this.context, environment, bundleStorage)",
    "        this.preferences = preferences":
      "        this.preferences = HotUpdaterSandboxDev.preferences(this.context, environment, preferences)",
    "        this.keyValueStorage = KeyValueStorageService(environment.keyValueStorageFile(this.context))":
      "        this.keyValueStorage = KeyValueStorageService(HotUpdaterSandboxDev.keyValueFile(this.context, environment))",
  ]

  /** `sourcePath` only names the file in a refusal. */
  static String generate(String source, String sourcePath) {
    def lines = source.replace("\r\n", "\n").split("\n", -1) as List<String>
    def refuse = { String what ->
      throw new IllegalStateException(
        "A sandbox build can't replace ${sourcePath}: ${what}.\n" +
          "Use the version of @hot-updater/react-native this CLI ships with, or undo the patch of that file.",
      )
    }

    if (lines.count { it == CLASS_LINE } != 1) refuse("it doesn't declare HotUpdaterImpl once")
    ASSIGNMENTS.each { line, replacement ->
      def found = lines.count { it == line }
      if (found != 1) refuse("expected one `${line.trim()}`, found ${found}")
    }

    def getterAt = uniqueLine(lines, GETTER, refuse)
    def anchorAt = nextStatement(lines, getterAt, GETTER_PRELUDE, GETTER_ANCHOR, "getJSBundleFile", refuse)
    def restartAt = uniqueLine(lines, RESTART, refuse)
    def restartAnchorAt = nextStatement(lines, restartAt, [], RESTART_ANCHOR, "restartApplication", refuse)

    def output = []
    lines.eachWithIndex { line, index ->
      if (index == anchorAt) output << GETTER_LINE
      if (index == restartAnchorAt) output << RESTART_LINE
      output << (ASSIGNMENTS[line] ?: line)
    }
    return HEADER + output.join("\n")
  }

  private static int uniqueLine(List<String> lines, String line, Closure refuse) {
    def found = lines.count { it == line }
    if (found != 1) refuse("expected one `${line.trim()}`, found ${found}")
    return lines.indexOf(line)
  }

  /**
   * The line of `anchor` in the function opening at `opening`, once the
   * statements before it are exactly `prelude`.
   */
  private static int nextStatement(
    List<String> lines,
    int opening,
    List<String> prelude,
    String anchor,
    String function,
    Closure refuse
  ) {
    def seen = []
    for (int index = opening + 1; index < lines.size(); index++) {
      def statement = lines[index].trim()
      if (statement.isEmpty() || statement.startsWith("//")) continue
      if (statement == anchor) {
        if (seen != prelude) refuse("`${function}` does something else before `${anchor}`: ${seen}")
        return index
      }
      seen << statement
      if (seen.size() > prelude.size()) refuse("`${function}` does something else before `${anchor}`: ${seen}")
    }
    refuse("`${function}` has no `${anchor}`")
    return -1
  }
}

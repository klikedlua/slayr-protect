
const { transformLuau } = require("./lib/transform");

// Inside your existing authenticated POST /api/obfuscate handler:
try {
    const { name, description = "", source, profile = "standard" } =
        req.body || {};

    if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({
            error: "Script name is required."
        });
    }

    if (typeof source !== "string" || !source.trim()) {
        return res.status(400).json({
            error: "Paste Luau code before transforming."
        });
    }

    const result = transformLuau(source, { profile });

    return res.json({
        output: result.output,
        stats: {
            inputBytes: result.inputBytes,
            outputBytes: result.outputBytes,
            savedBytes: result.inputBytes - result.outputBytes
        },
        profile: result.profile,
        notice: "Lexical minification complete; test the output before use."
    });
} catch (error) {
    return res.status(400).json({
        error: error.message || "Transformation failed."
    });
}


async function requestObfuscation(name, description, source, profile) {
    const response = await fetch("/api/obfuscate", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
            name,
            description,
            source,
            profile
        })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || "Transformation failed.");
    }

    if (typeof data.output !== "string") {
        throw new Error("The server returned no output.");
    }

    return data;
}

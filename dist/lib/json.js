export function jsonText(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
}

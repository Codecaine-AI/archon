class SupportEmail {
  sender string @description("The sender's email address")
  ask string @description("What the sender asks for, in one sentence")
}

// The extract node of email-intake. Its input is the raw email as JSON.
function ExtractSupportEmail(raw: string) -> SupportEmail {
  client PackDefault
  prompt #"
    {{ _.role("system") }}
    You read one support email, given as JSON with its headers and its body.
    Extract the sender and what the sender asks for.

    {{ ctx.output_format }}

    {{ _.role("user") }}
    {{ raw }}
  "#
}

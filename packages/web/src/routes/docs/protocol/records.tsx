import DocsLayout, { CodeBlock } from '~/components/DocsLayout'

const canonicalForm = `'{"id":' + JCS(id) + ',"type":' + JCS(type) + ',"data":' + JCS(data) + '}'

record hash = sha256(canonical form)        // 64 lowercase hex characters
record size = length of the canonical form in bytes`

const recordLine = `{"id":"pub-001","type":"Publication","data":{"title":"The Structure of Scientific Revolutions","pdf":{"$file":"sha256:9f86d0…"}}}
{"id":"pub-002","type":"Publication","data":{"title":"Notes"},"private":true}`

const rules: [string, string, string][] = [
  ['Duplicate keys', 'Two members of one object with equal keys', 'duplicate_key'],
  [
    'Unsafe integers',
    'An integer literal (no fraction or exponent) beyond 2⁵³ − 1. 1e20 is accepted.',
    'unsafe_integer',
  ],
  [
    'Lone surrogates',
    'An unpaired UTF-16 surrogate, raw or escaped, in a string or key',
    'lone_surrogate',
  ],
  ['Depth', 'Nesting deeper than 64 levels in data (the envelope adds one)', 'too_deep'],
  ['Record size', 'A canonical record over 8 MiB', 'record_too_large'],
  ['Record id', 'Missing, not a string, empty, or over 1,024 UTF-8 bytes', 'bad_id'],
  [
    'Type slug',
    'Missing, empty, over 128 bytes, starting with ".", or containing /, \\ or control characters',
    'bad_type',
  ],
  ['Envelope', 'Not an object, no data, or a non-boolean private', 'bad_envelope'],
  ['Syntax', 'Anything that isn’t JSON', 'syntax'],
]

export default function ProtocolRecords() {
  return (
    <DocsLayout title="Records and schemas" eyebrow="Protocol v2">
      <h2 id="canonical-json">Canonical JSON</h2>
      <p>
        Every hashed JSON document is written as{' '}
        <a href="https://www.rfc-editor.org/rfc/rfc8785">RFC 8785 (JCS)</a>: no whitespace, strings
        escaped as <code>JSON.stringify</code> does, numbers written as ECMAScript does (
        <code>-0</code> as <code>0</code>), and object members sorted by their keys&rsquo; UTF-16
        code units.
      </p>
      <p>
        In JavaScript, objects list integer-like keys (<code>&quot;9&quot;</code>,{' '}
        <code>&quot;10&quot;</code>) first whatever order they were added in, so sorting keys into a
        new object and calling <code>JSON.stringify</code> does not give JCS. Write the canonical
        form out as a string.
      </p>

      <h2 id="records">Records</h2>
      <p>
        A record is pushed as one JSON line with <code>id</code>, <code>type</code> and{' '}
        <code>data</code>, and optionally <code>&quot;private&quot;: true</code>. The private flag
        says which set the record goes in (see{' '}
        <a href="/docs/protocol/versions#access-sets">access sets</a>); it is not part of the record
        or its hash.
      </p>
      <CodeBlock>{recordLine}</CodeBlock>
      <p>
        The <strong>canonical form</strong> is a fixed envelope with only <code>data</code>{' '}
        canonicalized:
      </p>
      <CodeBlock>{canonicalForm}</CodeBlock>
      <p>
        Record ids are unique per type within a version, across both sets. Unicode is not
        normalized: <code>é</code> as one code point and as <code>e</code> plus a combining accent
        are different ids with different hashes.
      </p>

      <h2 id="input-rules">Input rules</h2>
      <p>
        Every record line and schema a client pushes is checked on its source text, because a parsed
        value has already lost what these rules need. A line that breaks one is refused with the
        error code shown.
      </p>
      <table>
        <tbody>
          {rules.map(([rule, what, code]) => (
            <tr key={code}>
              <td>{rule}</td>
              <td>{what}</td>
              <td>
                <code>{code}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="schemas">Schemas</h2>
      <p>
        Each type has a JSON Schema document. <strong>Schema hash</strong> = SHA-256 of its JCS. Two
        collections that define the same schema share one schema object.
      </p>
      <ul>
        <li>
          <code>&quot;private&quot;: true</code> at the schema&rsquo;s root makes the whole type
          private. A root <code>private</code> that isn&rsquo;t a boolean is refused, so{' '}
          <code>&quot;true&quot;</code> can&rsquo;t publish a type by accident.
        </li>
        <li>
          <code>&quot;private&quot;: true</code> on a property is refused: v2 has no field-level
          privacy. Put private fields in a private type, or push the record as private.
        </li>
        <li>
          A schema&rsquo;s canonical form is at most 256 KiB, and each <code>pattern</code> (or{' '}
          <code>patternProperties</code> key) at most 256 UTF-16 code units. A <code>pattern</code>{' '}
          inside <code>const</code>, <code>enum</code>, <code>default</code> or{' '}
          <code>examples</code> is data, not a regex.
        </li>
      </ul>

      <h2 id="validation">Validation</h2>
      <p>
        Schemas are JSON Schema <strong>draft-07</strong>. A <code>$schema</code>, if given, must
        name draft-07. A schema is refused unless it is valid against the draft-07 meta-schema,
        every pattern compiles as an ECMAScript regular expression with the <code>u</code> flag, and
        every <code>$ref</code> resolves within the schema or to the draft-07 meta-schema.
      </p>
      <ul>
        <li>
          Keywords beside <code>$ref</code> apply, as in draft 2019-09.
        </li>
        <li>
          Keywords draft-07 doesn&rsquo;t define are ignored (<code>unevaluatedProperties</code>,{' '}
          <code>prefixItems</code> and the like). <code>$defs</code> works as a container.
        </li>
        <li>String lengths count Unicode code points.</li>
        <li>
          <code>format</code> is checked for strings only, for the formats ajv-formats 3 defines in
          full mode (<code>date-time</code> and <code>time</code> need a time zone). Other format
          names are ignored.
        </li>
        <li>Only the verdict is normative, not the error messages.</li>
      </ul>
      <p>
        A push can ask the server to drop fields its schema doesn&rsquo;t define (
        <code>strip_unknown_fields</code>) instead of refusing them; the record is hashed after
        stripping.
      </p>

      <h2 id="files">Files</h2>
      <p>
        <strong>File hash</strong> = SHA-256 of the file&rsquo;s bytes. A record references a file
        through any object, at any depth of <code>data</code>, whose <code>$file</code> member is{' '}
        <code>sha256:</code> followed by 64 lowercase hex characters. A reference object is not
        searched further. A <code>$file</code> of any other form is not a reference.
      </p>
      <p>
        A file belongs to every set that has a record referencing it. A file declared in a push but
        referenced by no record is private, unless the push marks it public. Files are uploaded
        before the commit that references them, and a collection may only reference files it holds
        already or has uploaded itself.
      </p>
    </DocsLayout>
  )
}

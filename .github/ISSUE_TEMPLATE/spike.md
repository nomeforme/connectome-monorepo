---
name: Spike / Investigation
about: Investigate a problem, map it to code, assess feasibility
labels: spike, review-ready
---

## Problem Statement

<!-- What and why — 2-4 sentences. Written for stakeholders, not just engineers. -->

## Technical Context

<!-- What the investigation found about the current architecture. How things work today. -->

## Affected Components

| Component | Key Files | Role |
|-----------|-----------|------|
| <!-- component --> | `file1`, `file2` | <!-- role in this change --> |

## Technical Investigation

### Architecture Overview
<!-- How the affected subsystems work today. Data flow, component interactions. -->

### Code References

| Location | Description |
|----------|-------------|
| `file:line` | <!-- what this code does and why it's relevant --> |

### Current Behavior
<!-- What happens today in the code paths that would change. -->

### What Would Need to Change
<!-- Detailed breakdown of modifications needed, by component. -->

### Patterns to Follow
<!-- Existing patterns in the codebase the implementation should match. -->

## Proposed Approach

<!-- High-level strategy — NOT a full implementation plan. 3-6 sentences. -->

## Scope Assessment

- **Complexity:** <!-- Low / Medium / High -->
- **Confidence:** <!-- High / Medium / Low -->
- **Estimated files:** <!-- count -->
- **Packages affected:** <!-- list -->

## Risks & Open Questions

- <!-- risk or unknown needing human judgment -->

## Test Considerations

- <!-- testing strategy for this change -->

---
*Created by spike investigation. Use `build-from-issue` to plan and implement.*

# Access control matrix

| Action | Administrator | Member | Session participant | Node | Scoped API/MCP token |
| --- | --- | --- | --- | --- | --- |
| Create users, enrollment tokens, providers | Yes | No | No | No | No |
| List team projects/capacity | Yes | Yes | N/A | Own heartbeat only | project:read |
| Create project/repository binding | Yes | Yes | N/A | No | No |
| Read session transcript/tools | Yes | Only when participant | Yes | Assigned command only | Run scope plus project:read |
| Queue session message | Yes when participant | Yes when participant | Yes | No | children:write only for owned run |
| Steer/cancel/answer approval | Participant and capability/lease checks | Participant and capability/lease checks | Yes | Execute assigned command | Explicit run scope |
| Interactive claim | Yes | Yes | N/A | Registered coordination session | coordination:write |
| Replace node credential | Bearer token only | No | N/A | Receives a credential only from node-facing enrollment | fleet:admin (administrator, project-scoped, not run-scoped) |
| Enforced orchestration claim | Scheduler only | Scheduler only | Scheduler only | No | Narrow director request only |
| Gateway request detail | Yes | Redacted project/session-correlated detail | Redacted correlated detail | No | No |
| Memory/skill activation or promotion | Yes or configured human reviewer | Human decision routes where authorized | N/A | No | Proposal only |

Arguments never grant scope. The authenticated cookie, device credential, or hashed API token selects the team, project, run, and allowed operations before request parameters are evaluated.

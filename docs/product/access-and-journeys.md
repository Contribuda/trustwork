# Capabilities, permissions and journeys

## Orthogonal dimensions

Human identity, employer membership, object participation, role/permission, onboarding preference, commercial entitlement, authorship credit and delegated authority are separate records. Effective authority is the intersection of current principal rights, object grant, action conditions, current mandate and entitlement/budget when relevant. Deny by default. Platform support does not automatically inherit private negotiation access.

| Actor / grant | Personal page | Shared company | Private project/commercial data | Publish | Commit order | Configure prices |
|---|---|---|---|---|---|---|
| Anonymous | Public projection | Public projection | Never | Never | Never | Never |
| Registered industry participant | Own edit | Public unless member | Own projects or explicit grant | Own content under policy | Only separately authorized context | Never |
| Company member | Own edit | Read permitted member view | Only granted objects/actions | Only explicit authorship/editor grant | No default spend authority | Never |
| Company administrator | Own edit | Manage page/membership within role | Not automatically every private personal field | Company publish permission if granted | Separate procurement authority required | Company billing settings only if granted |
| Buyer/sales authorized operator | Own edit | Membership permission | Assigned RFQs/quotes/orders/projects | Separate right | Action/amount/conditions bound | Never |
| Project owner/leader | Own edit | Independent | Owner grants vs leader operational permissions distinct | Explicit selected public projection | Separate commercial authority | Never |
| Assistant worker | No independent identity authority | Mandate only | Principal/object/field constraints | Exact delegated publication scope | Mandate + principal + budget + approval policy | Never by default |
| Editorial/moderation | Public content policy | Public content policy | Only scoped case evidence | Editorial/moderation action | Never | Never |
| Commercial platform admin | Own profile | Own admin area | Billing minimum required | Separate editorial right | No customer transactions | Versioned platform offers/prices |
| Support | Own profile | Case-scoped diagnostic view | Explicit audited case grant | Never by default | Never | Never |

## Required end-to-end cases

1. **Reader/author without commerce:** register with one name, skip onboarding, read news, save interests, draft article, publish under policy, show on personal wall. No empty procurement/sales panels forced into daily view. No company required.
2. **Mixed company operator:** same person and same company buys facade panels and sells installation work concurrently. Overview shows both workflows; no persona/workspace switch. Ability to draft either quote does not imply ability to spend.
3. **Ambiguous intake:** user supplies spreadsheet and email thread, assistant extracts needs with evidence, asks missing requirements, prepares RFQ. Attachment parser cannot grant authority or send to extracted addresses by itself.
4. **Shared deal:** buyer A and supplier B negotiate quote v3; buyer budget and supplier floor stay private. Both see accepted terms v3; later catalogue v7 cannot change them. Unauthorized company C cannot fetch quote/attachment by guessed ID.
5. **Personal project:** human owns a renovation project and invites supplier/company participants with object-level rights. No company tenancy required. Company employment change does not transfer personally owned project.
6. **Employment change:** terminate membership, revoke company authority and queued mandates, keep human identity/public contributions, rebind login only with secure recovery. Former employee cannot export private company history unless explicitly granted.
7. **Mandated order:** assistant is allowed to choose eligible supplier below defined ceiling and required delivery terms. Reserve transaction budget; if paid comparison was requested, separately reserve platform budget. Missing condition -> escalation. Provider timeout -> reconciliation, not a second order.
8. **Client-caused delay:** baseline delivery due date differs from agreed change after client revised scope. Preserve original and changed plans, evidence and responsible party. Reputation excludes unexplained automatic supplier penalty; dispute/appeal available.
9. **Magazine reader:** discover latest numbered weekly issue, browse contents, read on small screen, download designed PDF, browse archived issues. Correction banner identifies revised article/version.
10. **Public/private boundary:** company publishes project story and open needs without revealing quotes, attachments, messages, budgets or internal commitments. Search index, export and notifications honor the same projection.

## Object authorization acceptance suite

Test every read, mutation, export, attachment URL, search result, notification and job: anonymous; own person; own company member without grant; authorized buyer; counterpart supplier with limited shared view; unrelated company; revoked membership; expired mandate; personally owned project participant; platform admin without case grant. Assert both forbidden field absence and rejected mutation. Database predicates cannot replace field-level serializers. Caches include access/projection version and must be invalidated on revocation.

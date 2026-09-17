---
id: "7581437859"
title: Technical Document
space: CDS4
url: https://inside-docupedia.bosch.com/confluence/spaces/CDS4/pages/7581437859/Technical+Document
version: 1
lastUpdated: 2026-09-10T05:12:09.000+02:00
lastUpdatedBy: IYH1HC
labels: []
ancestors:
  - SAP Corporate and ReUse Development Platform & Tools
exportedAt: 2026-09-10T03:12:15.782Z
---

_**In SolMan document type to be used for ULR link to Docupedia page: TDD (Technical Development Documentation)**_

**Template Change History:**

<table class="wrapped confluenceTable"><colgroup><col><col><col><col></colgroup><tbody><tr><th class="confluenceTh">Version</th><th class="confluenceTh">Date</th><th class="confluenceTh">Description</th><th class="confluenceTh">Author</th></tr><tr><td class="confluenceTd">v2.0</td><td class="confluenceTd"><div class="content-wrapper"><p><time datetime="2025-10-25" class="date-past">25 Oct 2025</time>&nbsp;</p></div></td><td class="confluenceTd">Consolidated Versions&nbsp;</td><td class="confluenceTd"><div class="content-wrapper"><p><a class="confluence-userlink user-mention" data-username="KJL5FE" href="https://inside-docupedia.bosch.com/confluence/display/~KJL5FE" data-linked-resource-id="1990990479" data-linked-resource-version="48" data-linked-resource-type="userinfo" data-base-url="https://inside-docupedia.bosch.com/confluence">Kulkarni Ajay (BD/ERA-EXL1)</a>&nbsp;</p></div></td></tr></tbody></table>

**Table of Contents** (please activate number headings in the toolbar above)**:**

-   [Motivation and Key Figures](#TechnicalDocument-MotivationandKeyFigures)
    -   [Short description and summary of functions](#TechnicalDocument-Shortdescriptionandsummaryoffunctions)
    -   [Business problems solved, benefits](#TechnicalDocument-Businessproblemssolved,benefits)
-   [Functional Description](#TechnicalDocument-FunctionalDescription)
-   [Technical Description (High-Level Architecture)](#TechnicalDocument-TechnicalDescription\(High-LevelArchitecture\))
    -   [Frontend components](#TechnicalDocument-Frontendcomponents)
    -   [Package structure and dependencies](#TechnicalDocument-Packagestructureanddependencies)
    -   [APIs and other external interfaces](#TechnicalDocument-APIsandotherexternalinterfaces)
    -   [Most important classes](#TechnicalDocument-Mostimportantclasses)
    -   [Data model](#TechnicalDocument-Datamodel)
    -   [Used SAP enhancements](#TechnicalDocument-UsedSAPenhancements)
    -   [Business Roles & Authorizations](#TechnicalDocument-BusinessRoles&Authorizations)
    -   [Output Management](#TechnicalDocument-OutputManagement)
    -   [Open Source Software (OSS)](#TechnicalDocument-OpenSourceSoftware\(OSS\))
    -   [Technical Debt Tracking](#TechnicalDocument-TechnicalDebtTracking)
-   [Deployment](#TechnicalDocument-Deployment)
    -   [Technical Prerequisites & Dependencies](#TechnicalDocument-TechnicalPrerequisites&Dependencies)
    -   [Transport Considerations](#TechnicalDocument-TransportConsiderations)
    -   [Local Adaptation](#TechnicalDocument-LocalAdaptation)
    -   [Local Role maintenance](#TechnicalDocument-LocalRolemaintenance)
    -   [Deletion and Phase-out](#TechnicalDocument-DeletionandPhase-out)
-   [Release Notes](#TechnicalDocument-ReleaseNotes)

**Page Release Status: `DRAFT`RELEASED``**

<table class="wrapped relative-table confluenceTable" style="width: 92.7341%;"><colgroup class=""><col class="" style="width: 8.97285%;"><col class="" style="width: 10.6043%;"><col class="" style="width: 7.74928%;"><col class="" style="width: 8.49702%;"><col class="" style="width: 10.0605%;"><col class="" style="width: 15.4306%;"><col class="" style="width: 21.6164%;"><col class="" style="width: 9.24476%;"><col class="" style="width: 7.81676%;"></colgroup><tbody class=""><tr class=""><th class="confluenceTh">Package Owner</th><th class="confluenceTh">Functional Specialist</th><th class="confluenceTh">Developer</th><th class="confluenceTh"><p>SolDoc Link /</p><p>Cloud ALM</p><p>Project Link</p></th><th class="confluenceTh">Design Review Link</th><th class="confluenceTh">Development Release Link T&amp;R</th><th class="confluenceTh"><p>Link to Business Process ( SolMan / Signavio)</p><p>[Optional]</p></th><th class="confluenceTh"><p>Business Process</p><p>ID.</p><p>[Optional]</p></th><th class="confluenceTh"><p>ITR Link</p><p>[Optional]</p></th></tr><tr class=""><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td><td class="confluenceTd"><br></td></tr></tbody></table>

**Page Revision History:**

<table class="wrapped relative-table confluenceTable" style="width: 92.7341%;"><colgroup class=""><col class="" style="width: 4.75834%;"><col class="" style="width: 9.10883%;"><col class="" style="width: 45.7481%;"><col class="" style="width: 16.7902%;"><col class="" style="width: 23.588%;"></colgroup><tbody class=""><tr class=""><th class="confluenceTh">Version</th><th colspan="1" class="confluenceTh">Date</th><th class="confluenceTh">Description</th><th class="confluenceTh">Author</th><th class="confluenceTh"><p>Link to SolMan Change Request /</p><p>SAP Cloud ALM Feature</p></th></tr><tr class=""><td colspan="1" class="confluenceTd"><br></td><td colspan="1" class="confluenceTd"><div class="content-wrapper"><p><time datetime="2025-10-01" class="date-past">01 Oct 2025</time>&nbsp;</p></div></td><td colspan="1" class="confluenceTd"><br></td><td colspan="1" class="confluenceTd"><br></td><td colspan="1" class="confluenceTd"><br></td></tr></tbody></table>

**How to use versions**

-   First major version to be set when document is set to "Released" → 1.0
-   Editorial changes, e.g. correction of typos, broken links → no version change
-   Minor changes, e.g. amending one or few sentences → 1.1, 1.2, 1.3,..
-   Major changes, e.g. adding new chapters or sections → 2.0, 3.0,...
-   There is no synchronization between document versions and technical object versions

# Motivation and Key Figures

_Why was this package created, what's the main purpose, key-figures like number of users etc._

## Short description and summary of functions

_Provide a short description of the main functions for the reader to get a basic understanding_

## Business problems solved, benefits

_optionally add a PowerPoint slide with details, graphics, screenshots,.._

# Functional Description

_Describe the individual functions of the product (create sub-chapters per function). Per feature describe, e.g._

-   _starting point of program (in the process)_
-   _determination logic_
-   _functional dependencies_
-   _customizing entries_
-   _result (of sub steps)_
-   _variances_

# Technical Description (High-Level Architecture)

## Frontend components

Technical documentation of Fiori is done according [Documenting Fiori UI5 objects in SAP Solution Manager documentation](https://inside-docupedia.bosch.com/confluence/display/CDS4/Documenting+Fiori+UI5+objects+in+SAP+Solution+Manager+documentation)

## Package structure and dependencies

_e.g. package interface use accesses_

<table class="wrapped confluenceTable"><colgroup><col><col></colgroup><tbody><tr><th scope="col" class="confluenceTh">TDD</th><th scope="col" class="confluenceTh">Minimum Version</th></tr><tr><td class="confluenceTd"><p><em>Link to technical design document</em></p><p><em>of packages consumed&nbsp;</em></p><p><em>e.g ABAP2XLSX , ABAPLOGGER</em></p></td><td class="confluenceTd"><em>If applicable&nbsp;</em></td></tr></tbody></table>

## APIs and other external interfaces

_both, provided and consumed interfaces_

_Add link to Interface Instantiation Guide“ (s. [here](https://inside-docupedia.bosch.com/confluence/x/WihXag) for example)_

## Most important classes

_responsibility and collaborators of the major classes  
_

## Data model

_if new custom Business Objects are created; incl. CDS Views_

## Used SAP enhancements

## Business Roles & Authorizations

_Business roles in terms of groups of users (e.g. sales accountant), technical authorizations_

## Output Management

_Printouts, Adobe Forms etc.  
_

## Open Source Software (OSS)

_Describe any open source software used by this package and provide mandatory OSS information if used, e.g. scan results_ 

<table class="relative-table wrapped confluenceTable" style="width: 73.2381%;"><colgroup class=""><col class="" style="width: 31.2348%;"><col class="" style="width: 31.7554%;"><col class="" style="width: 20.6914%;"><col class="" style="width: 16.3983%;"></colgroup><tbody class=""><tr class=""><th class="confluenceTh">SolDoc Link</th><th class="confluenceTh">Version No. / Build Information</th><th class="confluenceTh">License Type&nbsp;</th><th class="confluenceTh">Additional Details (Optional)</th></tr><tr class=""><td class="confluenceTd"><p><em>SolDoc Link of the OSS consumed&nbsp;</em></p></td><td class="confluenceTd"><p><em>Version Information , Incase it is not available the build date of the GitHub repository&nbsp;</em></p></td><td class="confluenceTd"><p><em>Link to License&nbsp;information&nbsp;</em></p><p><em>e.g. MIT , Apache 2.0&nbsp;</em></p></td><td class="confluenceTd"><em>Link to CD Shop , TDD , Internal&nbsp; wiki</em></td></tr></tbody></table>

## Technical Debt Tracking 

_The Technical Debt rating for the package needs to be provided  in the following format or replace it with a Jira filter with the similar fields_ 

<table class="relative-table wrapped confluenceTable" style="width: 74.0434%;"><colgroup class=""><col style="width: 31.369%;"><col class="" style="width: 11.7637%;"><col class="" style="width: 16.3669%;"><col class="" style="width: 12.4456%;"><col class="" style="width: 28.0453%;"></colgroup><tbody class=""><tr class=""><th class="confluenceTh">Link to Jira&nbsp;</th><th class="confluenceTh">Technical Debt Rating&nbsp;&nbsp;</th><th class="confluenceTh">Reviewed on</th><th class="confluenceTh">Reviewed by</th><th class="confluenceTh">Additional Details (Optional)</th></tr><tr class=""><td class="confluenceTd"><p><em>Details of the technical debt , Link to Jira ticket containing the information&nbsp;</em></p></td><td class="confluenceTd"><div class="content-wrapper"><p><span class="status-macro aui-lozenge aui-lozenge-error aui-lozenge-subtle">VERY HIGH<span class="status-macro aui-lozenge aui-lozenge-moved aui-lozenge-subtle"> HIGH<span class="status-macro aui-lozenge aui-lozenge-success aui-lozenge-subtle">MEDIUM<span class="status-macro aui-lozenge aui-lozenge-subtle">LOW<span class="status-macro aui-lozenge aui-lozenge-current aui-lozenge-subtle">NONE</span></span></span></span></span></p></div></td><td class="confluenceTd"><div class="content-wrapper"><p><em style="letter-spacing: 0.0px;color:var(--ds-icon-accent-blue,#1D7AFC);"><em>Date on which the technical dept was reviewed&nbsp; (</em><em>DD- MM- YYYY)&nbsp;</em><em>&nbsp;</em></em></p><p><em style="letter-spacing: 0.0px;color:var(--ds-icon-accent-blue,#1D7AFC);"><time datetime="2025-01-01" class="date-past">01 Jan 2025</time>&nbsp;</em></p></div></td><td class="confluenceTd"><p><em>The development expert that performed the review&nbsp;</em></p><p><em>@NTID (ABC123)</em></p></td><td class="confluenceTd"><em>Link to technical debt approval , Why the technical dept was</em> accepted&nbsp;</td></tr></tbody></table>

# Deployment 

## Technical Prerequisites & Dependencies

_e.g. AddOns, Business Functions, dependencies to other packages,..._

## Transport Considerations

_e.g. sequence, downtime-relevance, critical objects,..)_

## Local Adaptation

_e.g. customizing, code, enhancements or BADIs in solution code)_

## Local Role maintenance

## Deletion and Phase-out

_e.g. for temporary solutions, how to remove the package from the system, how to handle existing data (archiving?)  
_

# Release Notes

| Date | Transport | Comment |
| --- | --- | --- |
|   
 |   
 |   
 |
|   
 |   
 |   
 |

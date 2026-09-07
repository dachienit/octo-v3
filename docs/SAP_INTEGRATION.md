# SAP Ecosystem Integration

Octo is uniquely positioned as a production-ready framework for building AI agents within the SAP ecosystem. It provides native support for SAP BTP services and common SAP development models.

## 1. SAP BTP Deployment

Octo is designed to run on **SAP BTP, Cloud Foundry Runtime**.

### Cloud Foundry Manifest (`mta.yaml`)
The project includes an `mta.yaml` file for deployment. It defines the necessary services:
- **`core-service`**: The main backend application.
- **`approuter`**: The SAP standard component for authentication (XSUAA) and routing.
- **Service Bindings**: Connects Octo to XSUAA, Object Store, and Connectivity services.

### Authentication (XSUAA)
Octo leverages SAP XSUAA for user authentication and authorization.
- The `approuter` handles the initial login.
- Octo validates JWT tokens issued by XSUAA.
- User identities are mapped to Octo's internal user system.

## 2. SAP AI Core Integration

Octo integrates with **SAP AI Core** to provide access to generative AI models (like GPT-4 or Claude) in a secure, enterprise-compliant manner.

### Features:
- **OAuth2 Flow**: Automatically handles token acquisition and refresh using SAP AI Core service keys.
- **Deployment Management**: Routes requests to specific deployment IDs in SAP AI Core.
- **Resource Groups**: Supports SAP AI Core resource groups for multi-tenancy and isolation.
- **Regional Support**: Adapts to different AI Core regions (e.g., `us10`, `eu10`).

## 3. SAP ABAP & CAP Development

Octo provides specialized "Skills" and "Templates" for SAP developers.

### SAP ABAP Template
- **Skills**: Includes deep knowledge of ABAP syntax, ABAP Cloud, RAP (RESTful ABAP Programming Model), and ABAP CDS.
- **Tools**: Can be extended with tools to interact with ABAP systems via ADT (ABAP Development Tools) services.

### SAP CAP Template
- **Skills**: Guidance for SAP Cloud Application Programming Model (CDS modeling, Node.js/Java handlers, Fiori annotations).
- **Project Structure**: Pre-configured to work within a CAP project structure.

## 4. Connectivity & Destinations

Octo can leverage the **SAP BTP Connectivity Service** and **Destination Service** to reach on-premise or cloud systems.

- **Destinations**: The agent can be granted access to specific SAP BTP Destinations, allowing it to call OData or REST services in S/4HANA or other systems securely via the Cloud Connector.
- **Connectivity Extension**: A dedicated connector handles the proxying of requests through the BTP Connectivity infrastructure.

## 5. SAP ADT Configuration Architecture (Three-Tier)

To balance secure credential management, collaborative workspace definitions, and offline workspace consistency, Octo implements a structured **Three-Tier SAP ADT Configuration Architecture**. This separates configurations into three distinct layers based on ownership and scope:

### Tier 1: Shared Workspace settings (`workspace.json`)
* **Location**: `workspace/workspaces/<workspace_id>/workspace.json`
* **Ownership**: Shared team configuration.
* **Scope**: Defines which SAP connections are mounted and available for development inside the workspace.
* **Metadata**: Contains connection IDs, base URLs, message servers, target clients, and languages.
* **Security**: **NEVER** stores passwords, Kerberos credentials, or private access tickets on disk. It serves as a shared, credential-free team picklist.

### Tier 2: Private User Profiles (`config.json`)
* **Location**: `workspace/users/<user_id>/connectors/sap-adt/home/.adt-cli/config.json`
* **Ownership**: Private individual developer.
* **Scope**: Serves as the profile store for the underlying `adt-cli` application.
* **Metadata**: Maps connection names to standard basic authentication details (usernames and encrypted/base64 passwords), Kerberos SPNs, or bearer JWT tokens.
* **Isolation**: Guarantees multi-user isolation. Two developers working in the same workspace edit the same files under `artifacts/` but authenticate using their own respective SAP logons, keeping audit logs correct and preventing credential pollution.

### Tier 3: Local Folder Sidecars (`connection.json`)
* **Location**: `workspace/workspaces/<workspace_id>/artifacts/<connection_name>/.adt/connection.json`
* **Ownership**: Local workspace caching.
* **Scope**: Ties the physical folder hierarchy under `artifacts/<connection_name>/` with its backing SAP system metadata.
* **Metadata**: Caches connection non-sensitive properties (such as client, language, URL, and auth type) so the client tools do not have to perform slow database roundtrips.
* **Usage**: Checked automatically by workspace scanners and the `sapgit` tool to recognize valid connection directories, map relative file paths back to their correct SAP ADT URIs, and load matching static configurations (e.g. `pull-config.json` and `abaplint.json`).


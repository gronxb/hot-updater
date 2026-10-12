# The emulator ports and connection strings of the service on PORT. Sourced by
# e2e-service.sh and e2e-cleanup.sh; hot-updater.config.ts of the E2E app
# derives the same values from PORT.
service_port="${PORT:?PORT is required}"
export COSMOS_PORT=$((service_port + 15000))
export AZURITE_PORT=$((service_port + 14000))
export COSMOS_CONTAINER="hot-updater-azure-cosmos-${service_port}"
export AZURITE_CONTAINER="hot-updater-azure-azurite-${service_port}"
# The emulators' well-known keys, accepted only by them.
export HOT_UPDATER_AZURE_COSMOS_CONNECTION_STRING="AccountEndpoint=http://127.0.0.1:${COSMOS_PORT}/;AccountKey=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==;"
export HOT_UPDATER_AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${AZURITE_PORT}/devstoreaccount1;"
export HOT_UPDATER_AZURE_BLOB_CONTAINER="hot-updater"

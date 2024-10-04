const command = process.argv[2];

switch (command) {
  case 'getUpdateJson':
    console.log(JSON.stringify([]));
    break;
  default:
    console.error(`unknown command ${command}`);
    process.exit(1);
}

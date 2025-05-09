import {runInit} from "../dist/iac/index.js"

runInit({build: "bare"}).catch(e => console.log("An error occurred", e))

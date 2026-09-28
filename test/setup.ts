import { afterAll } from "vitest";
import { removeMaterialised } from "./helpers/fixture.js";

// Each test file deletes the temporary repositories it made, so repeated runs
// do not fill the temp directory (a large one slows down every test that
// walks up to the filesystem root).
afterAll(removeMaterialised);

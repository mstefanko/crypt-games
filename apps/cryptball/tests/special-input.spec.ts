import {test,expect} from "@playwright/test";
test("retired specials have no HUD or keyboard activation",async({page})=>{
 await page.goto("/games/cryptball/?sport=cryptkick");
 await page.getByRole("button",{name:"Practice",exact:true}).click();
 await expect.poll(async()=>{const resume=page.getByRole("button",{name:"Resume",exact:true});if(await resume.isVisible())await resume.click();return page.locator("#overlay").isHidden();},{timeout:30000}).toBe(true);
 await expect(page.locator("#special-hud")).toHaveCount(0);
 await page.keyboard.press("KeyB");
 await expect(page.locator("#overlay")).toBeHidden();
});

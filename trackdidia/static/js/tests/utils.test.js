define(["app/build/utils"], function(Utils){

    describe("The function convertToHourString", function() {
        var hour;
        it("should return the correct hour string", function() {
            hour = 12;
            expect(Utils.convertToHourString(hour)).toEqual("12h");
            hour = 13.5;
            expect(Utils.convertToHourString(hour)).toEqual("13h30");

        });
    });

});
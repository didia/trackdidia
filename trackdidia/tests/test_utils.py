'''
Created on 2014-10-30

@author: didia
'''
import datetime
import unittest

from trackdidia.models import utils


class TestUtils(unittest.TestCase):


    def testGetWeekStartAndEnd(self):
        utils.today = datetime.date(2014, 10, 29)
        monday, sunday = utils.get_week_start_and_end()
       
        self.assertEqual(datetime.date(2014,10,27), monday)
        self.assertEqual(datetime.date(2014,11,2), sunday)
    
    def testGetTodayId(self):
        utils.today = datetime.date(2014,10,27)
        self.assertEqual(1, utils.get_today_id())
        utils.today = datetime.date(2014,11,2)
        self.assertEqual(7, utils.get_today_id())
    
    def testGetWeekId(self):
        utils.today = datetime.date(2014,10,29)
        weekid = utils.get_week_id()
        self.assertEqual("2014102720141102", weekid)
    def testGetLastWeekId(self):
        utils.today = datetime.date(2014, 10, 29)
        weekid = utils.get_last_week_id()
        self.assertEquals("2014102020141026", weekid)
if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()
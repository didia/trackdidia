'''
Created on 2014-10-30

@author: didia
'''
import datetime
import unittest

from trackdidia.models import utils


class TestUtils(unittest.TestCase):


    def testGetWeekStartAndEnd(self):
        monday, sunday = utils.get_week_start_and_end(today=datetime.date(2014,10,29))
       
        self.assertEqual(datetime.date(2014,10,27), monday)
        self.assertEqual(datetime.date(2014,11,2), sunday)
    
    def testGetTodayId(self):
        self.assertEqual(1, utils.get_today_id(datetime.date(2014,10,27)))
        self.assertEqual(7, utils.get_today_id(datetime.date(2014,11,2)))

if __name__ == "__main__":
    #import sys;sys.argv = ['', 'Test.testName']
    unittest.main()